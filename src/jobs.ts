/**
 * Background jobs for the screening loop.
 *
 * A screen job runs in three phases:
 *   - expanding: walks seeds × suffixes through (cached) autocomplete, adds
 *     seed × modifier combos, filters app titles / tracked / excluded / off-topic
 *     terms, and stores every surviving candidate at once (status `candidate`);
 *   - selecting: once every seed is expanded, applies maxCandidates globally:
 *     seeds first, then autocomplete-sourced, then combos, round-robin across
 *     seeds inside each class so early seeds cannot starve later ones. The rest
 *     become `truncated`. Expand-only jobs stop here;
 *   - checking: rank-checks the selection through the search limiter,
 *     persisting each result immediately.
 * Selection needs the whole candidate pool, so checks start after expansion.
 *
 * Async jobs run in a detached worker process (dist/worker.js <jobId>) so they
 * survive the MCP client: stdio clients SIGTERM the server they spawned when
 * they disconnect, which would kill an in-process job. Synchronous calls run
 * the same Job class in-process and await it.
 *
 * State is mirrored to screen.sqlite on every step (heartbeat = updated_at),
 * so any server process can report it. Cancellation and pace changes are
 * fields in the store that the workers poll, which also works across
 * processes. A 403 never fails a job: the limiter's backoff is waited out and
 * the call retried, in every phase; cancel is the only exit. A running job
 * whose worker pid is dead, or whose heartbeat is older than STALE_MS, is
 * reported as aborted and its pending candidates released.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkOneWithRetry, normalizeTerm, summarizeTop10, type BatchItemResult, type RetryState } from "./apple.js";
import { AppleRateLimitError } from "./ratelimit.js";
import { rateStatus, searchLimiter, suggestLimiter } from "./ratelimit.js";
import { attachSharedLimiters } from "./limiterstore.js";
import { ScreenStore, type CandidateSource, type JobRecord, type JobStatus } from "./screenstore.js";
import { suggestionsWithFlags } from "./suggest.js";
import { defaultIncludeAny, matchesAny } from "./terms.js";

export const STALE_MS = 15 * 60_000;
export const DEFAULT_SUFFIXES = ["", "calc", "c", "l", "t", "a", "p"];

export interface ScreenJobInput {
  kind: "screen";
  seeds: string[];
  appId: string;
  countries: string[];
  suffixes: string[];
  modifiers: string[];
  /** Whole-word phrases; a candidate containing any of them is dropped. */
  exclude: string[];
  tracked: string[];
  /** Whole-word words; a candidate must contain at least one. Undefined = the seed words (see defaultIncludeAny). */
  includeAny?: string[];
  maxCandidates: number;
  rescreenAfterDays: number;
  depth: number;
  searchPaceMs?: number;
  suggestPaceMs?: number;
  expandOnly: boolean;
}

export interface BatchJobInput {
  kind: "batch";
  terms: string[];
  appId: string;
  countries: string[];
  depth: number;
  searchPaceMs?: number;
  force: boolean;
  maxAgeHours: number;
}

export type JobInput = ScreenJobInput | BatchJobInput;

export interface RecentCheck {
  term: string;
  country: string;
  position: number | null;
  checkedTop: number;
  maxReviews: number | null;
  error?: string;
  cached?: boolean;
  at: string;
}

export interface JobState {
  phase: "expanding" | "selecting" | "checking" | "finished";
  seedsTotal: number;
  seedsExpanded: number;
  queriesTotal: number;
  queriesDone: number;
  suggestionCalls: number;
  suggestionCacheHits: number;
  serpCalls: number;
  /** Autocomplete/SERP queries that failed for a non-throttling reason and were skipped. */
  queryErrors: number;
  /** Rate-limit responses seen during expansion (each waited out and retried). */
  expansionRateLimits: number;
  rawSuggestions: number;
  candidatesFound: number;
  candidatesSkipped: number;
  candidatesTruncated: number;
  /** Candidates cut by maxCandidates, per seed. */
  truncatedBySeed: Record<string, number>;
  /** The includeAny filter in force (explicit or derived from the seeds). */
  includeAny: string[];
  dropped: { appNames: number; excluded: number; tracked: number; tooShort: number; notIncluded: number };
  checksTotal: number;
  checksDone: number;
  checksOk: number;
  checksFailed: number;
  rateLimits: number;
  backoffSeconds: number;
  etaSeconds: number | null;
  /** Search spacing actually enforced for this job's calls (floor × adaptive multiplier, or the job's own pace if longer). */
  effectiveSearchPaceMs: number;
  /** Limiter state of the process running the job (the worker), captured at the last heartbeat. */
  rate: ReturnType<typeof rateStatus> | null;
  recent: RecentCheck[];
  error: string | null;
  warning: string | null;
}

function newState(): JobState {
  return {
    phase: "expanding",
    seedsTotal: 0, seedsExpanded: 0, queriesTotal: 0, queriesDone: 0,
    suggestionCalls: 0, suggestionCacheHits: 0, serpCalls: 0, queryErrors: 0, expansionRateLimits: 0, rawSuggestions: 0,
    candidatesFound: 0, candidatesSkipped: 0, candidatesTruncated: 0, truncatedBySeed: {}, includeAny: [],
    dropped: { appNames: 0, excluded: 0, tracked: 0, tooShort: 0, notIncluded: 0 },
    checksTotal: 0, checksDone: 0, checksOk: 0, checksFailed: 0,
    rateLimits: 0, backoffSeconds: 0, etaSeconds: null, effectiveSearchPaceMs: 0, rate: null, recent: [], error: null, warning: null,
  };
}

class CancelledError extends Error {
  constructor() {
    super("Job cancelled");
    this.name = "CancelledError";
  }
}

/** Candidate queue consumed by the rank worker. */
class Queue<T> {
  private items: T[] = [];
  private closed = false;
  private waiters: Array<() => void> = [];
  push(item: T): void {
    this.items.push(item);
    this.wake();
  }
  close(): void {
    this.closed = true;
    this.wake();
  }
  get size(): number {
    return this.items.length;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  /** Next item, or null once the queue is closed and drained. */
  async next(signal?: AbortSignal): Promise<T | null> {
    for (;;) {
      if (this.items.length) return this.items.shift()!;
      if (this.closed) return null;
      if (signal?.aborted) return null;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

// ------------------------------------------------------------ selection

export interface Candidate {
  term: string;
  source: CandidateSource;
  seed: string;
}

const SOURCE_ORDER: CandidateSource[] = ["seed", "autocomplete", "combo"];

/**
 * Apply maxCandidates to the whole pool: seeds first, then autocomplete
 * suggestions, then combos; inside each class take one candidate per seed in
 * turn (round-robin, seeds in first-seen order) until the budget is spent.
 */
export function selectCandidates(pool: Candidate[], max: number): { selected: Candidate[]; truncated: Candidate[] } {
  const selected: Candidate[] = [];
  const truncated: Candidate[] = [];
  let budget = Math.max(0, max);
  for (const source of SOURCE_ORDER) {
    const bySeed = new Map<string, Candidate[]>();
    for (const c of pool) {
      if (c.source !== source) continue;
      const list = bySeed.get(c.seed);
      if (list) list.push(c);
      else bySeed.set(c.seed, [c]);
    }
    const lanes = [...bySeed.values()];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const lane of lanes) {
        const c = lane.shift();
        if (!c) continue;
        progressed = true;
        if (budget > 0) {
          selected.push(c);
          budget -= 1;
        } else truncated.push(c);
      }
    }
  }
  return { selected, truncated };
}

// ------------------------------------------------------------ job

export class Job {
  readonly id: string;
  readonly kind: JobInput["kind"];
  createdAt = new Date().toISOString();
  status: JobStatus = "running";
  finishedAt: string | null = null;
  readonly state = newState();
  /** Full per-term results, kept only for synchronous callers. */
  readonly results: BatchItemResult[] = [];
  private readonly abort = new AbortController();
  private readonly store: ScreenStore;
  private checkDurations: number[] = [];
  private lastPersist = 0;
  /** Heartbeat so a worker sleeping through a long backoff still looks alive to other processes. */
  private heartbeat: NodeJS.Timeout | null = null;
  readonly done: Promise<void>;

  constructor(readonly input: JobInput, opts: { id?: string; store?: ScreenStore; createdAt?: string } = {}) {
    this.id = opts.id ?? newJobId(input.kind);
    if (opts.createdAt) this.createdAt = opts.createdAt;
    this.kind = input.kind;
    const store = opts.store;
    this.store = store ?? new ScreenStore();
    this.persist(true);
    this.heartbeat = setInterval(() => this.persist(true), 30_000);
    this.heartbeat.unref();
    this.done = this.run().finally(() => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!store) this.store.close();
    });
  }

  cancel(): void {
    this.abort.abort(new CancelledError());
  }

  /** Change the pacing of a running job in this process (the store copy is updated by the caller). */
  setPace(patch: { searchPaceMs?: number; suggestPaceMs?: number }): void {
    if ("searchPaceMs" in patch) this.input.searchPaceMs = patch.searchPaceMs;
    if ("suggestPaceMs" in patch && this.input.kind === "screen") this.input.suggestPaceMs = patch.suggestPaceMs;
  }

  record(): JobRecord {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      pid: process.pid,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      finishedAt: this.finishedAt,
      input: this.input,
      state: this.snapshot(),
    };
  }

  /** State with live limiter-derived fields filled in. */
  snapshot(): JobState {
    const rs = rateStatus();
    const s = this.state;
    s.backoffSeconds = Math.max(rs.search.currentBackoffSeconds, s.phase === "expanding" ? rs.autocomplete.currentBackoffSeconds : 0);
    s.effectiveSearchPaceMs = Math.round(searchLimiter.effectivePace(this.input.searchPaceMs));
    s.etaSeconds = this.eta();
    s.rate = rs;
    return { ...s, dropped: { ...s.dropped }, truncatedBySeed: { ...s.truncatedBySeed }, includeAny: [...s.includeAny], recent: [...s.recent] };
  }

  private eta(): number | null {
    if (this.status !== "running") return 0;
    const s = this.state;
    const searchPace = searchLimiter.effectivePace(this.input.searchPaceMs) / 1000;
    const avgCheck = this.checkDurations.length ? this.checkDurations.reduce((a, b) => a + b, 0) / this.checkDurations.length / 1000 : searchPace;
    const remainingChecks = Math.max(0, s.checksTotal - s.checksDone);
    let eta = remainingChecks * Math.max(avgCheck, searchPace);
    if (s.phase === "expanding" && this.input.kind === "screen") {
      const remainingQueries = Math.max(0, s.queriesTotal - s.queriesDone);
      const suggestPace = suggestLimiter.effectivePace(this.input.suggestPaceMs) / 1000;
      // Checks follow expansion. Guess how many candidates are still coming at the observed rate, capped by the budget.
      const perQuery = s.queriesDone ? s.candidatesFound / s.queriesDone : 2;
      const expected = Math.min(this.input.maxCandidates, s.candidatesFound + remainingQueries * perQuery);
      const checks = this.input.expandOnly ? 0 : expected * this.input.countries.length;
      eta = remainingQueries * suggestPace + (s.seedsTotal - s.seedsExpanded) * searchPace /* one SERP per seed */ + checks * Math.max(avgCheck, searchPace);
    }
    return Math.round(eta + s.backoffSeconds);
  }

  private persist(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPersist < 1000) return;
    this.lastPersist = now;
    this.store.saveJob(this.record());
  }

  /** Between steps: honour a cancel request and pick up pace changes made through the store. */
  private poll(): void {
    if (this.abort.signal.aborted) throw new CancelledError();
    const rec = this.store.getJob(this.id);
    if (!rec) return;
    if (rec.cancelRequested) {
      this.cancel();
      throw new CancelledError();
    }
    const stored = rec.input as Partial<ScreenJobInput>;
    this.input.searchPaceMs = stored.searchPaceMs;
    if (this.input.kind === "screen") this.input.suggestPaceMs = stored.suggestPaceMs;
  }

  private finish(status: JobStatus, error?: string): void {
    this.status = status;
    this.state.phase = "finished";
    if (error) this.state.error = error;
    this.finishedAt = new Date().toISOString();
    if (status !== "done") this.store.finishPendingCandidates(this.id, status === "cancelled" ? "cancelled" : "error", error ?? status);
    this.persist(true);
  }

  private async run(): Promise<void> {
    try {
      if (this.input.kind === "batch") await this.runBatch(this.input);
      else await this.runScreen(this.input);
      if (this.status === "running") this.finish("done");
    } catch (e) {
      if (this.status !== "running") return;
      if (e instanceof CancelledError || this.abort.signal.aborted) this.finish("cancelled", "Cancelled");
      else this.finish("failed", e instanceof Error ? e.message : String(e));
    }
  }

  // ------------------------------------------------------------ rank worker

  private reuseRecent(term: string, country: string, appId: string, maxAgeMs: number): BatchItemResult | null {
    const row = this.store.latestRank(term, country, appId, maxAgeMs);
    if (!row) return null;
    return { term, country, appId, attempts: 0, position: row.position, checkedTop: row.checkedTop, topApps: row.topApps, top10: summarizeTop10(row.topApps), checkedAt: row.checkedAt, cached: true } as BatchItemResult & { cached: true };
  }

  private noteResult(r: BatchItemResult, cached: boolean, source: string): void {
    const s = this.state;
    s.checksDone += 1;
    if (r.error) s.checksFailed += 1;
    else s.checksOk += 1;
    if (!cached) this.store.saveRank(r, source);
    this.store.updateJobCandidate(this.id, r.term, r.country, r.error ? "error" : "done", r.position ?? null, r.error);
    s.recent.unshift({
      term: r.term, country: r.country, position: r.position ?? null, checkedTop: r.checkedTop ?? 0,
      maxReviews: r.top10?.maxReviews ?? null, ...(r.error ? { error: r.error } : {}), ...(cached ? { cached: true } : {}), at: new Date().toISOString(),
    });
    if (s.recent.length > 10) s.recent.length = 10;
    this.results.push(r);
    this.persist();
  }

  /** Consume the queue until it is closed and drained. Rate limits are waited out indefinitely; only cancel stops the worker. */
  private async rankWorker(queue: Queue<{ term: string; country: string }>, appId: string, depth: number, source: string): Promise<void> {
    const retry: RetryState = { consecutiveRateLimits: 0, rateLimitHits: 0 };
    for (;;) {
      const next = await queue.next(this.abort.signal);
      this.poll();
      if (!next) return;
      const t0 = Date.now();
      const { item } = await checkOneWithRetry(next.term, appId, next.country, retry, {
        depth, paceMs: this.input.searchPaceMs, signal: this.abort.signal, maxConsecutiveRateLimits: Infinity,
      });
      this.state.rateLimits = retry.rateLimitHits;
      this.checkDurations.push(Date.now() - t0);
      if (this.checkDurations.length > 50) this.checkDurations.shift();
      this.noteResult(item, false, source);
    }
  }

  /** Enqueue a term×country, reusing a stored check when fresh enough. Returns true when queued for an Apple call. */
  private enqueue(queue: Queue<{ term: string; country: string }>, term: string, country: string, appId: string, maxAgeMs: number): boolean {
    const cached = maxAgeMs > 0 ? this.reuseRecent(term, country, appId, maxAgeMs) : null;
    if (cached) {
      if (this.store.addJobCandidate(this.id, term, country, "skipped")) {
        this.state.candidatesSkipped += 1;
        this.state.checksTotal += 1;
        this.noteResult(cached, true, "");
      }
      return false;
    }
    if (!this.store.addJobCandidate(this.id, term, country, "pending")) return false;
    this.state.checksTotal += 1;
    queue.push({ term, country });
    return true;
  }

  // ------------------------------------------------------------ batch

  private async runBatch(input: BatchJobInput): Promise<void> {
    const queue = new Queue<{ term: string; country: string }>();
    const maxAgeMs = input.force ? 0 : input.maxAgeHours * 3_600_000;
    const terms = [...new Set(input.terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    this.state.phase = "checking";
    for (const country of input.countries) for (const term of terms) this.enqueue(queue, term, country, input.appId, maxAgeMs);
    queue.close();
    this.persist(true);
    await this.rankWorker(queue, input.appId, input.depth, "batch");
  }

  // ------------------------------------------------------------ screen

  private async runScreen(input: ScreenJobInput): Promise<void> {
    const s = this.state;
    const seeds = [...new Set(input.seeds.map(normalizeTerm).filter(Boolean))];
    const primary = input.countries[0];
    const maxAgeMs = input.rescreenAfterDays * 86_400_000;
    const excluded = input.exclude.map(normalizeTerm).filter(Boolean);
    const tracked = new Set(input.tracked.map(normalizeTerm));
    const includeAny = input.includeAny ?? defaultIncludeAny(seeds);
    s.includeAny = includeAny;
    s.seedsTotal = seeds.length;
    s.queriesTotal = seeds.length * input.suffixes.length;
    this.persist(true);

    // ---- expanding
    const seen = new Map<string, boolean>(); // normalized term -> isAppName
    const pool: Candidate[] = [];
    const consider = (term: string, source: CandidateSource, seed: string, isAppName: boolean) => {
      if (!term) return;
      const prev = seen.get(term);
      if (prev !== undefined) {
        if (isAppName && !prev) seen.set(term, true); // learned later that it is a title; already stored rows stay
        return;
      }
      seen.set(term, isAppName);
      s.rawSuggestions += 1;
      if (isAppName) return void (s.dropped.appNames += 1);
      if (matchesAny(term, excluded)) return void (s.dropped.excluded += 1);
      if (tracked.has(term)) return void (s.dropped.tracked += 1);
      if (term.length < 3) return void (s.dropped.tooShort += 1);
      if (source !== "seed" && includeAny.length && !matchesAny(term, includeAny)) return void (s.dropped.notIncluded += 1);
      pool.push({ term, source, seed });
      s.candidatesFound += 1;
      for (const c of input.countries) this.store.addJobCandidate(this.id, term, c, "candidate", source, seed);
    };

    /** One autocomplete query: rate limits wait out the backoff and retry; other errors skip the query. */
    const expandQuery = async (q: string, seed: string, namesBySeed: Map<string, string[]>) => {
      for (;;) {
        this.poll();
        try {
          return await suggestionsWithFlags(this.store, q, primary, {
            signal: this.abort.signal,
            paceMs: input.suggestPaceMs,
            serpPaceMs: input.searchPaceMs,
            extraNames: namesBySeed.get(seed),
            serpLookup: !namesBySeed.has(seed),
          });
        } catch (e) {
          if (this.abort.signal.aborted) throw e;
          if (e instanceof AppleRateLimitError) {
            s.expansionRateLimits += 1;
            this.persist(true);
            continue; // the limiter's backoff makes the next attempt wait
          }
          s.queryErrors += 1;
          s.warning = `Skipped query '${q}': ${e instanceof Error ? e.message : String(e)}`;
          return null;
        }
      }
    };

    const namesBySeed = new Map<string, string[]>();
    for (const seed of seeds) {
      consider(seed, "seed", seed, false); // seeds are queries by definition
      for (const suf of input.suffixes) {
        const q = suf ? `${seed} ${suf}` : seed;
        const res = await expandQuery(q, seed, namesBySeed);
        s.queriesDone += 1;
        if (!res) {
          this.persist();
          continue;
        }
        if (!namesBySeed.has(seed)) namesBySeed.set(seed, res.namesUsed);
        if (res.fromCache) s.suggestionCacheHits += 1;
        else s.suggestionCalls += 1;
        s.serpCalls += res.serpCalls;
        for (const sg of res.suggestions) consider(normalizeTerm(sg.term), "autocomplete", seed, sg.isAppName === true);
        this.persist();
      }
      for (const m of input.modifiers) consider(normalizeTerm(`${seed} ${m}`), "combo", seed, false);
      s.seedsExpanded += 1;
      this.persist();
    }

    // ---- selecting
    s.phase = "selecting";
    this.persist(true);
    const { selected, truncated } = selectCandidates(pool, input.maxCandidates);
    if (truncated.length) {
      this.store.markTruncated(this.id, truncated.map((c) => c.term));
      s.candidatesTruncated = truncated.length;
      for (const c of truncated) s.truncatedBySeed[c.seed] = (s.truncatedBySeed[c.seed] ?? 0) + 1;
    }
    if (input.expandOnly) return;

    // ---- checking
    s.phase = "checking";
    const queue = new Queue<{ term: string; country: string }>();
    for (const c of selected) for (const country of input.countries) this.enqueue(queue, c.term, country, input.appId, maxAgeMs);
    queue.close();
    this.persist(true);
    await this.rankWorker(queue, input.appId, input.depth, "screen");
  }
}

// ---------------------------------------------------------------- registry

function newJobId(kind: string): string {
  return `${kind}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`;
}

const jobs = new Map<string, Job>();

/** Run a job in this process (synchronous tool calls). */
export function startJob(input: JobInput): Job {
  const job = new Job(input);
  jobs.set(job.id, job);
  job.done.finally(() => {
    // Keep finished jobs in memory for an hour for cheap status reads.
    setTimeout(() => jobs.delete(job.id), 3_600_000).unref();
  });
  return job;
}

/**
 * Persist the job and hand it to a detached worker process. Returns at once.
 * The worker is in its own process group and ignores our stdio, so the MCP
 * client's SIGTERM on disconnect never reaches it. Dead jobs are swept first.
 */
export function startDetachedJob(input: JobInput, store: ScreenStore): { id: string; state: JobState } {
  reconcileRunning(store);
  const id = newJobId(input.kind);
  const now = new Date().toISOString();
  const state = newState();
  if (input.kind === "screen") {
    const seeds = [...new Set(input.seeds.map(normalizeTerm).filter(Boolean))];
    state.seedsTotal = seeds.length;
    state.queriesTotal = state.seedsTotal * input.suffixes.length;
    state.includeAny = input.includeAny ?? defaultIncludeAny(seeds);
  } else {
    state.phase = "checking";
    state.checksTotal = new Set(input.terms.map((t) => t.trim().toLowerCase()).filter(Boolean)).size * input.countries.length;
  }
  state.effectiveSearchPaceMs = Math.round(searchLimiter.effectivePace(input.searchPaceMs));
  store.saveJob({ id, kind: input.kind, status: "running", pid: null, createdAt: now, updatedAt: now, finishedAt: null, input, state });
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.js");
  const child = spawn(process.execPath, [workerPath, id], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return { id, state };
}

/** Entry point for dist/worker.js: run a persisted job to completion. */
export async function runWorker(id: string): Promise<void> {
  attachSharedLimiters();
  const store = new ScreenStore();
  const rec = store.getJob(id);
  if (!rec) throw new Error(`No job ${id}`);
  const job = new Job(rec.input as JobInput, { id, store, createdAt: rec.createdAt });
  jobs.set(id, job);
  const stop = () => job.cancel();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  try {
    await job.done;
  } finally {
    store.close();
  }
}

/** true = alive (or alive but not ours: EPERM), false = gone, null = unknown pid. */
export function pidAlive(pid: number | null): boolean | null {
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM" ? true : false;
  }
}

export function runningJobs(): Job[] {
  return [...jobs.values()].filter((j) => j.status === "running");
}

export interface JobView {
  jobId: string;
  kind: JobInput["kind"];
  status: JobStatus;
  owner: "this-process" | "other-process" | "none";
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  elapsedSeconds: number;
  cancelRequested: boolean;
  progress: JobState;
  input: unknown;
}

function view(rec: JobRecord & { cancelRequested?: boolean }, owner: JobView["owner"]): JobView {
  const end = rec.finishedAt ? Date.parse(rec.finishedAt) : Date.now();
  return {
    jobId: rec.id,
    kind: rec.kind,
    status: rec.status,
    owner,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    finishedAt: rec.finishedAt,
    elapsedSeconds: Math.round((end - Date.parse(rec.createdAt)) / 1000),
    cancelRequested: rec.cancelRequested ?? false,
    progress: rec.state as JobState,
    input: rec.input,
  };
}

/** Status of a job from memory when it runs here, else from the store (with stale detection). */
export function jobStatus(store: ScreenStore, id: string): JobView | null {
  const live = jobs.get(id);
  if (live) return view({ ...live.record(), cancelRequested: store.jobCancelRequested(id) }, "this-process");
  const rec = store.getJob(id);
  if (!rec) return null;
  return view(reconcile(store, rec), rec.status === "running" ? "other-process" : "none");
}

/**
 * A job marked running in the store whose worker pid is dead, or that never
 * got a worker (no pid a minute after creation), or whose heartbeat stopped
 * for STALE_MS, belongs to a dead process: report it as aborted and release
 * its pending candidates.
 */
function reconcile(store: ScreenStore, rec: JobRecord & { cancelRequested: boolean }): JobRecord & { cancelRequested: boolean } {
  if (rec.status !== "running" || jobs.has(rec.id)) return rec;
  const alive = pidAlive(rec.pid);
  const sinceUpdate = Date.now() - Date.parse(rec.updatedAt);
  const dead = alive === false || (alive === null && sinceUpdate > 60_000) || sinceUpdate > STALE_MS;
  if (dead) {
    const why = alive === false ? `worker process ${rec.pid} is gone` : alive === null ? "no worker process started" : "no heartbeat for 15 min";
    const state = { ...(rec.state as JobState), phase: "finished" as const, error: `Job ended before finishing: ${why}` };
    const fixed = { ...rec, status: "aborted" as const, finishedAt: rec.updatedAt, state };
    store.saveJob(fixed);
    store.finishPendingCandidates(rec.id, "error", "server ended");
    return fixed;
  }
  return rec;
}

/** Reconcile every job the store still marks running (dead workers become aborted). */
export function reconcileRunning(store: ScreenStore): void {
  for (const rec of store.listJobs("running", 1000)) reconcile(store, rec);
}

export function listJobs(store: ScreenStore, status?: JobStatus, limit = 50): JobView[] {
  return store.listJobs(status, limit).map((rec) => {
    const live = jobs.get(rec.id);
    if (live) return view({ ...live.record(), cancelRequested: rec.cancelRequested }, "this-process");
    const r = reconcile(store, rec);
    return view(r, r.status === "running" ? "other-process" : "none");
  });
}

/** Cancel a job here or, for another process, by flagging the store (its workers poll the flag). */
export function cancelJob(store: ScreenStore, id: string): { found: boolean; status?: JobStatus; note: string } {
  const live = jobs.get(id);
  store.requestJobCancel(id);
  if (live) {
    if (live.status !== "running") return { found: true, status: live.status, note: "Job had already finished" };
    live.cancel();
    return { found: true, status: "running", note: "Cancel signalled; the job stops after its current Apple call" };
  }
  const rec = store.getJob(id);
  if (!rec) return { found: false, note: "No such job" };
  if (rec.status !== "running") return { found: true, status: rec.status, note: "Job had already finished" };
  return { found: true, status: "running", note: "Cancel requested in the store; the owning process stops at its next step" };
}

/**
 * Change a running job's pacing. The store copy is patched (the owning worker
 * re-reads it before its next Apple call) and a job in this process is updated
 * at once. The limiter floor still applies: a pace below it has no effect.
 */
export function updateJobPace(
  store: ScreenStore,
  id: string,
  patch: { searchPaceMs?: number; suggestPaceMs?: number },
): { found: boolean; status?: JobStatus; effectiveSearchPaceMs?: number; effectiveSuggestPaceMs?: number; note: string } {
  const rec = store.getJob(id);
  if (!rec) return { found: false, note: "No such job" };
  if (rec.status !== "running") return { found: true, status: rec.status, note: "Job has already finished" };
  store.updateJobInput(id, patch);
  jobs.get(id)?.setPace(patch);
  const input = { ...(rec.input as Partial<ScreenJobInput>), ...patch };
  return {
    found: true,
    status: "running",
    effectiveSearchPaceMs: Math.round(searchLimiter.effectivePace(input.searchPaceMs)),
    effectiveSuggestPaceMs: Math.round(suggestLimiter.effectivePace(input.suggestPaceMs)),
    note: jobs.has(id) ? "Applied to the running job" : "Stored; the owning process applies it before its next Apple call",
  };
}
