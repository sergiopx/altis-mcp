/**
 * Background jobs for the screening loop.
 *
 * A job runs two workers over an in-memory queue:
 *   - expansion: walks seeds × suffixes through (cached) autocomplete, filters
 *     app titles / tracked / excluded terms, and pushes new candidates;
 *   - rank: consumes candidates as soon as they exist and rank-checks them
 *     through the search limiter, persisting each result immediately.
 * So the first rank check runs seconds after the job starts instead of after
 * the whole seed list has been expanded.
 *
 * Async jobs run in a detached worker process (dist/worker.js <jobId>) so they
 * survive the MCP client: stdio clients SIGTERM the server they spawned when
 * they disconnect, which would kill an in-process job. Synchronous calls run
 * the same Job class in-process and await it.
 *
 * State is mirrored to screen.sqlite on every step (heartbeat = updated_at),
 * so any server process can report it. Cancellation is a flag in the store
 * that the workers poll, which also works across processes. A running job
 * whose worker pid is dead, or whose heartbeat is older than STALE_MS, is
 * reported as aborted.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkOneWithRetry, normalizeTerm, summarizeTop10, type BatchItemResult, type RetryState } from "./apple.js";
import { rateStatus, searchLimiter, suggestLimiter } from "./ratelimit.js";
import { ScreenStore, type JobRecord, type JobStatus } from "./screenstore.js";
import { suggestionsWithFlags } from "./suggest.js";

export const STALE_MS = 15 * 60_000;
export const DEFAULT_SUFFIXES = ["", "calc", "c", "l", "t", "a", "p"];

export interface ScreenJobInput {
  kind: "screen";
  seeds: string[];
  appId: string;
  countries: string[];
  suffixes: string[];
  modifiers: string[];
  exclude: string[];
  tracked: string[];
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
  phase: "expanding" | "checking" | "finished";
  seedsTotal: number;
  seedsExpanded: number;
  queriesTotal: number;
  queriesDone: number;
  suggestionCalls: number;
  suggestionCacheHits: number;
  serpCalls: number;
  rawSuggestions: number;
  candidatesFound: number;
  candidatesSkipped: number;
  candidatesTruncated: number;
  dropped: { appNames: number; excluded: number; tracked: number; tooShort: number };
  checksTotal: number;
  checksDone: number;
  checksOk: number;
  checksFailed: number;
  rateLimits: number;
  backoffSeconds: number;
  etaSeconds: number | null;
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
    suggestionCalls: 0, suggestionCacheHits: 0, serpCalls: 0, rawSuggestions: 0,
    candidatesFound: 0, candidatesSkipped: 0, candidatesTruncated: 0,
    dropped: { appNames: 0, excluded: 0, tracked: 0, tooShort: 0 },
    checksTotal: 0, checksDone: 0, checksOk: 0, checksFailed: 0,
    rateLimits: 0, backoffSeconds: 0, etaSeconds: null, rate: null, recent: [], error: null, warning: null,
  };
}

class CancelledError extends Error {
  constructor() {
    super("Job cancelled");
    this.name = "CancelledError";
  }
}

/** Candidate queue shared by the two workers. */
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
  private readonly startedMs = Date.now();
  private checkDurations: number[] = [];
  private lastPersist = 0;
  readonly done: Promise<void>;

  constructor(readonly input: JobInput, opts: { id?: string; store?: ScreenStore; createdAt?: string } = {}) {
    this.id = opts.id ?? newJobId(input.kind);
    if (opts.createdAt) this.createdAt = opts.createdAt;
    this.kind = input.kind;
    const store = opts.store;
    this.store = store ?? new ScreenStore();
    this.persist(true);
    this.done = this.run().finally(() => {
      if (!store) this.store.close();
    });
  }

  cancel(): void {
    this.abort.abort(new CancelledError());
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
    s.etaSeconds = this.eta();
    s.rate = rs;
    return { ...s, dropped: { ...s.dropped }, recent: [...s.recent] };
  }

  private eta(): number | null {
    if (this.status !== "running") return 0;
    const s = this.state;
    const searchPace = (this.input.searchPaceMs ?? searchLimiter.paceMs) / 1000;
    const avgCheck = this.checkDurations.length ? this.checkDurations.reduce((a, b) => a + b, 0) / this.checkDurations.length / 1000 : searchPace;
    const remainingChecks = Math.max(0, s.checksTotal - s.checksDone);
    let eta = remainingChecks * Math.max(avgCheck, searchPace);
    if (s.phase === "expanding" && this.input.kind === "screen") {
      const remainingQueries = Math.max(0, s.queriesTotal - s.queriesDone);
      const suggestPace = (this.input.suggestPaceMs ?? suggestLimiter.paceMs) / 1000;
      // Expansion and checking overlap; the longer of the two bounds the job. Guess more candidates are coming at the observed rate.
      const perQuery = s.queriesDone ? s.candidatesFound / s.queriesDone : 2;
      const expected = remainingQueries * perQuery * this.input.countries.length;
      eta = Math.max(remainingQueries * suggestPace, (remainingChecks + expected) * Math.max(avgCheck, searchPace));
    }
    return Math.round(eta + s.backoffSeconds);
  }

  private persist(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPersist < 1000) return;
    this.lastPersist = now;
    this.store.saveJob(this.record());
  }

  private checkCancel(): void {
    if (this.abort.signal.aborted) throw new CancelledError();
    if (this.store.jobCancelRequested(this.id)) this.cancel(), this.checkCancel();
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
      if (this.status !== "running") return; // already finished (e.g. aborted by the rank worker)
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

  /** Consume the queue until it is closed and drained. Returns false if the batch aborted on sustained 403s. */
  private async rankWorker(queue: Queue<{ term: string; country: string }>, appId: string, depth: number, paceMs: number | undefined, source: string): Promise<void> {
    const retry: RetryState = { consecutiveRateLimits: 0, rateLimitHits: 0 };
    for (;;) {
      const next = await queue.next(this.abort.signal);
      this.checkCancel();
      if (!next) return;
      if (this.state.phase === "expanding" && queue.isClosed) this.state.phase = "checking";
      const t0 = Date.now();
      const { item, aborted } = await checkOneWithRetry(next.term, appId, next.country, retry, { depth, paceMs, signal: this.abort.signal });
      this.state.rateLimits = retry.rateLimitHits;
      this.checkDurations.push(Date.now() - t0);
      if (this.checkDurations.length > 50) this.checkDurations.shift();
      this.noteResult(item, false, source);
      if (aborted) {
        this.finish("aborted", `Stopped after ${retry.consecutiveRateLimits} consecutive rate-limit responses on the search endpoint; retry later`);
        this.abort.abort(new CancelledError()); // stop the expansion worker too, so the process exits
        return;
      }
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
    await this.rankWorker(queue, input.appId, input.depth, input.searchPaceMs, "batch");
  }

  // ------------------------------------------------------------ screen

  private async runScreen(input: ScreenJobInput): Promise<void> {
    const s = this.state;
    const queue = new Queue<{ term: string; country: string }>();
    const seeds = [...new Set(input.seeds.map(normalizeTerm).filter(Boolean))];
    const primary = input.countries[0];
    const maxAgeMs = input.rescreenAfterDays * 86_400_000;
    const excluded = new Set(input.exclude.map(normalizeTerm));
    const tracked = new Set(input.tracked.map(normalizeTerm));
    s.seedsTotal = seeds.length;
    s.queriesTotal = seeds.length * input.suffixes.length;
    this.persist(true);

    const seen = new Map<string, boolean>(); // normalized term -> isAppName
    let accepted = 0;
    const consider = (term: string, isAppName: boolean) => {
      if (!term) return;
      const prev = seen.get(term);
      if (prev !== undefined) {
        if (isAppName && !prev) seen.set(term, true); // learned later that it is a title; already queued rows stay
        return;
      }
      seen.set(term, isAppName);
      s.rawSuggestions += 1;
      if (isAppName) return void (s.dropped.appNames += 1);
      if (excluded.has(term)) return void (s.dropped.excluded += 1);
      if (tracked.has(term)) return void (s.dropped.tracked += 1);
      if (term.length < 3) return void (s.dropped.tooShort += 1);
      if (accepted >= input.maxCandidates) return void (s.candidatesTruncated += 1);
      accepted += 1;
      s.candidatesFound += 1;
      if (!input.expandOnly) for (const c of input.countries) this.enqueue(queue, term, c, input.appId, maxAgeMs);
    };

    const expansion = (async () => {
      try {
        const namesBySeed = new Map<string, string[]>();
        for (const seed of seeds) {
          consider(seed, false); // seeds are queries by definition
          for (const suf of input.suffixes) {
            this.checkCancel();
            const q = suf ? `${seed} ${suf}` : seed;
            const res = await suggestionsWithFlags(this.store, q, primary, {
              signal: this.abort.signal,
              paceMs: input.suggestPaceMs,
              serpPaceMs: input.searchPaceMs,
              extraNames: namesBySeed.get(seed),
              serpLookup: !namesBySeed.has(seed),
            });
            if (!namesBySeed.has(seed)) namesBySeed.set(seed, res.namesUsed);
            if (res.fromCache) s.suggestionCacheHits += 1;
            else s.suggestionCalls += 1;
            s.serpCalls += res.serpCalls;
            for (const sg of res.suggestions) consider(normalizeTerm(sg.term), sg.isAppName === true);
            s.queriesDone += 1;
            this.persist();
          }
          for (const m of input.modifiers) consider(normalizeTerm(`${seed} ${m}`), false);
          s.seedsExpanded += 1;
          this.persist();
        }
      } finally {
        queue.close();
        if (s.phase === "expanding") s.phase = "checking";
        this.persist(true);
      }
    })();

    if (input.expandOnly) {
      await expansion;
      return;
    }
    const rank = this.rankWorker(queue, input.appId, input.depth, input.searchPaceMs, "screen");
    // If expansion throws (e.g. autocomplete rate-limited out), stop the rank worker too.
    const results = await Promise.allSettled([expansion, rank]);
    for (const r of results) if (r.status === "rejected") throw r.reason;
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
 * client's SIGTERM on disconnect never reaches it.
 */
export function startDetachedJob(input: JobInput, store: ScreenStore): { id: string; state: JobState } {
  const id = newJobId(input.kind);
  const now = new Date().toISOString();
  const state = newState();
  if (input.kind === "screen") {
    state.seedsTotal = new Set(input.seeds.map(normalizeTerm).filter(Boolean)).size;
    state.queriesTotal = state.seedsTotal * input.suffixes.length;
  } else {
    state.phase = "checking";
    state.checksTotal = new Set(input.terms.map((t) => t.trim().toLowerCase()).filter(Boolean)).size * input.countries.length;
  }
  store.saveJob({ id, kind: input.kind, status: "running", pid: null, createdAt: now, updatedAt: now, finishedAt: null, input, state });
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.js");
  const child = spawn(process.execPath, [workerPath, id], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return { id, state };
}

/** Entry point for dist/worker.js: run a persisted job to completion. */
export async function runWorker(id: string): Promise<void> {
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

function pidAlive(pid: number | null): boolean | null {
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
 * for STALE_MS, belongs to a dead process: report it as aborted.
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
