import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJob, jobStatus, cancelJob, listJobs, pidAlive, selectCandidates, updateJobPace, STALE_MS, type Candidate } from "../dist/jobs.js";
import { ScreenStore } from "../dist/screenstore.js";
import { searchLimiter, suggestLimiter } from "../dist/ratelimit.js";
import type { AppResult } from "../dist/apple.js";

const app = (i: number, name = `App ${i}`): AppResult => ({
  trackId: i, bundleId: `com.test.a${i}`, trackName: name, sellerName: "s", primaryGenreName: "Health & Fitness", trackViewUrl: "", userRatingCount: 10, releaseDate: "2024-01-01T00:00:00Z",
});
const hintsXml = (terms: string[]) => terms.map((t) => `<dict><key>term</key><string>${t}</string></dict>`).join("");

function useTempStore() {
  const dir = mkdtempSync(join(tmpdir(), "jobs-"));
  process.env.ALTIS_MCP_DATA_DIR = dir;
  return () => {
    delete process.env.ALTIS_MCP_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  };
}

function mockApple(opts: { hintDelayMs?: number; searchDelayMs?: number; log: string[] }) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    const term = u.searchParams.get("term") ?? "";
    if (u.hostname === "search.itunes.apple.com") {
      opts.log.push(`hints:${term}`);
      if (opts.hintDelayMs) await new Promise((r) => setTimeout(r, opts.hintDelayMs));
      const seed = term.split(" ")[0];
      return new Response(`<plist>${hintsXml([`${seed} calculator`, `${seed} calc pro`, `${seed} - loader app`, `${seed} tracker`])}</plist>`, { status: 200 });
    }
    opts.log.push(`search:${term}`);
    if (opts.searchDelayMs) await new Promise((r) => setTimeout(r, opts.searchDelayMs));
    const results = [app(1, `${term} pro`), app(42)];
    return new Response(JSON.stringify({ resultCount: results.length, results }), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = origFetch;
  };
}

test.beforeEach(() => {
  searchLimiter.reset();
  suggestLimiter.reset();
  searchLimiter.paceMs = 0;
  suggestLimiter.paceMs = 0;
});

test("screen job: expansion completes and selection runs before the first rank check", async () => {
  const cleanup = useTempStore();
  const log: string[] = [];
  const restore = mockApple({ hintDelayMs: 15, log });
  try {
    const job = startJob({
      kind: "screen", seeds: ["plate", "barbell", "wendler", "squat"], appId: "42", countries: ["US"], suffixes: ["", "c"], modifiers: [], exclude: ["squat tracker"],
      tracked: ["plate calculator"], maxCandidates: 100, rescreenAfterDays: 7, depth: 50, expandOnly: false,
    });
    assert.equal(job.status, "running");
    // No check may start before every seed is expanded (selection needs the whole pool).
    const until = Date.now() + 5000;
    while (Date.now() < until && job.state.checksDone === 0) {
      assert.equal(job.state.checksDone, 0);
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(job.state.seedsExpanded, job.state.seedsTotal, "expansion finished before the first check");
    assert.ok(log.filter((l) => l.startsWith("search:")).length > 0);
    await job.done;
    assert.equal(job.status, "done");
    const s = job.state;
    assert.equal(s.seedsExpanded, 4);
    assert.equal(s.queriesDone, 8);
    assert.ok(s.dropped.appNames >= 4, "title-looking suggestions dropped");
    assert.equal(s.dropped.tracked, 1);
    assert.equal(s.dropped.excluded, 1);
    assert.deepEqual(s.includeAny, ["plate", "barbell", "wendler", "squat"], "includeAny defaults to the seed words");
    assert.equal(s.candidatesTruncated, 0);
    assert.equal(s.checksDone, s.checksTotal);
    assert.equal(s.checksFailed, 0);
    assert.ok(s.recent.length > 0 && s.recent.length <= 10);
    const store = new ScreenStore();
    const view = jobStatus(store, job.id)!;
    assert.equal(view.status, "done");
    assert.equal(view.owner, "this-process");
    assert.equal(store.jobCandidateCounts(job.id).done, s.checksTotal);
    assert.equal(store.results({ appId: "42" }).total, s.checksTotal);
    assert.equal(store.pendingSummary().pendingTerms, 0);
    // Second run of the same seeds: everything served from cache and recent checks, zero Apple calls.
    log.length = 0;
    const again = startJob({ ...job.input, tracked: ["plate calculator"] } as typeof job.input);
    await again.done;
    assert.equal(log.length, 0, "no Apple calls on re-run");
    assert.equal(again.state.candidatesSkipped, s.checksTotal);
    store.close();
  } finally {
    restore();
    cleanup();
  }
});

test("batch job: async status, results persisted, listing", async () => {
  const cleanup = useTempStore();
  const log: string[] = [];
  const restore = mockApple({ log });
  try {
    const job = startJob({ kind: "batch", terms: ["a one", "b two", "A ONE"], appId: "42", countries: ["US", "MX"], depth: 50, force: true, maxAgeHours: 24 });
    assert.equal(job.state.checksTotal, 4, "deduped terms × countries");
    await job.done;
    assert.equal(job.status, "done");
    assert.equal(job.results.length, 4);
    assert.ok(job.results.every((r) => r.position === 2));
    const store = new ScreenStore();
    const jobs = listJobs(store);
    assert.equal(jobs[0].jobId, job.id);
    assert.equal(jobs[0].progress.checksDone, 4);
    store.close();
  } finally {
    restore();
    cleanup();
  }
});

test("cancel stops a running job and marks pending candidates", async () => {
  const cleanup = useTempStore();
  const log: string[] = [];
  const restore = mockApple({ searchDelayMs: 30, log });
  try {
    const job = startJob({ kind: "batch", terms: Array.from({ length: 20 }, (_, i) => `term ${i}`), appId: "42", countries: ["US"], depth: 50, force: true, maxAgeHours: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const store = new ScreenStore();
    const c = cancelJob(store, job.id);
    assert.equal(c.found, true);
    await job.done;
    assert.equal(job.status, "cancelled");
    assert.ok(job.state.checksDone < 20);
    const counts = store.jobCandidateCounts(job.id);
    assert.ok((counts.cancelled ?? 0) > 0);
    assert.equal(jobStatus(store, job.id)!.status, "cancelled");
    store.close();
  } finally {
    restore();
    cleanup();
  }
});

test("a running job from a dead process is reported as aborted once stale", () => {
  const cleanup = useTempStore();
  try {
    const store = new ScreenStore();
    const old = new Date(Date.now() - STALE_MS - 60_000).toISOString();
    store.saveJob({ id: "screen_dead", kind: "screen", status: "running", pid: 1, createdAt: old, updatedAt: old, finishedAt: null, input: {}, state: { phase: "checking" } });
    store.addJobCandidate("screen_dead", "x", "US", "pending");
    const fresh = new Date().toISOString();
    store.saveJob({ id: "screen_alive", kind: "screen", status: "running", pid: process.pid, createdAt: fresh, updatedAt: fresh, finishedAt: null, input: {}, state: { phase: "checking" } });
    store.saveJob({ id: "screen_deadpid", kind: "screen", status: "running", pid: 2_000_000_000, createdAt: fresh, updatedAt: fresh, finishedAt: null, input: {}, state: { phase: "checking" } });
    const dead = jobStatus(store, "screen_dead")!;
    assert.equal(dead.status, "aborted");
    assert.equal(jobStatus(store, "screen_deadpid")!.status, "aborted", "dead worker pid is detected at once");
    assert.equal(store.jobCandidateCounts("screen_dead").error, 1);
    const alive = jobStatus(store, "screen_alive")!;
    assert.equal(alive.status, "running");
    assert.equal(alive.owner, "other-process");
    assert.equal(cancelJob(store, "screen_alive").status, "running");
    assert.equal(store.getJob("screen_alive")!.cancelRequested, true);
    store.close();
  } finally {
    cleanup();
  }
});

test("pidAlive: our pid is alive, a huge pid is dead, pid 1 (EPERM) counts as alive, null is unknown", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2_000_000_000), false);
  assert.equal(pidAlive(1), true);
  assert.equal(pidAlive(null), null);
});

test("selectCandidates: seeds, then autocomplete, then combos; round-robin across seeds inside a class", () => {
  const c = (term: string, source: Candidate["source"], seed: string): Candidate => ({ term, source, seed });
  const pool = [
    c("a", "seed", "a"), c("a 1", "autocomplete", "a"), c("a 2", "autocomplete", "a"), c("a 3", "autocomplete", "a"), c("a x", "combo", "a"),
    c("b", "seed", "b"), c("b 1", "autocomplete", "b"), c("b 2", "autocomplete", "b"), c("b x", "combo", "b"),
    c("c", "seed", "c"), c("c 1", "autocomplete", "c"),
  ];
  const { selected, truncated } = selectCandidates(pool, 7);
  assert.deepEqual(selected.map((x) => x.term), ["a", "b", "c", "a 1", "b 1", "c 1", "a 2"]);
  assert.deepEqual(truncated.map((x) => x.term), ["b 2", "a 3", "a x", "b x"]);
  assert.equal(selectCandidates(pool, 100).truncated.length, 0);
  assert.equal(selectCandidates([], 5).selected.length, 0);
});

test("expand-only job stores every candidate with source and seed; truncation is global and round-robin; filters are whole-word", async () => {
  const cleanup = useTempStore();
  const origFetch = globalThis.fetch;
  const hints: Record<string, string[]> = {
    plate: ["plate calculator", "pay by plate chicago", "template maker", "plate calculator"],
    wendler: ["wendler 531", "wendler calc", "wendler 531 app"],
  };
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    const term = u.searchParams.get("term")!;
    if (u.hostname === "search.itunes.apple.com") return new Response(`<plist>${hintsXml(hints[term] ?? [])}</plist>`, { status: 200 });
    return new Response(JSON.stringify({ resultCount: 1, results: [app(42)] }), { status: 200 });
  }) as typeof fetch;
  try {
    const job = startJob({
      kind: "screen", seeds: ["plate", "wendler"], appId: "42", countries: ["US"], suffixes: [""], modifiers: ["app"], exclude: ["pay by plate"], tracked: [],
      maxCandidates: 4, rescreenAfterDays: 0, depth: 50, expandOnly: true,
    });
    await job.done;
    assert.equal(job.status, "done");
    const s = job.state;
    assert.equal(s.dropped.excluded, 1, "'pay by plate chicago' matched the exclude phrase");
    assert.equal(s.dropped.notIncluded, 1, "'template maker' contains no seed word ('plate' is not a whole word of it)");
    // pool: seeds plate, wendler; autocomplete plate calculator, wendler 531, wendler calc, wendler 531 app; combos plate app, wendler app  → 8, budget 4
    assert.equal(s.candidatesFound, 8);
    assert.equal(s.candidatesTruncated, 4);
    assert.deepEqual(s.truncatedBySeed, { wendler: 3, plate: 1 });
    assert.equal(s.checksTotal, 0, "expand-only: no checks");
    const store = new ScreenStore();
    const counts = store.jobCandidateCounts(job.id);
    assert.equal(counts.candidate, 4);
    assert.equal(counts.truncated, 4);
    assert.equal(counts.pending ?? 0, 0);
    const all = store.listJobCandidates(job.id);
    assert.equal(all.total, 8);
    const selected = store.listJobCandidates(job.id, { status: "candidate" }).candidates.map((c) => `${c.source}:${c.seed}:${c.term}`).sort();
    assert.deepEqual(selected, ["autocomplete:plate:plate calculator", "autocomplete:wendler:wendler 531", "seed:plate:plate", "seed:wendler:wendler"]);
    assert.deepEqual(store.candidateCountsBySeed(job.id, "truncated"), { wendler: 3, plate: 1 });
    assert.equal(store.pendingSummary().pendingTerms, 0, "candidate rows are not pending checks");
    assert.equal(jobStatus(store, job.id)!.status, "done");
    store.close();
  } finally {
    globalThis.fetch = origFetch;
    cleanup();
  }
});

test("screen_job_update changes the pace of a running job here and in the store", async () => {
  const cleanup = useTempStore();
  const log: string[] = [];
  const restore = mockApple({ searchDelayMs: 20, log });
  try {
    const job = startJob({ kind: "batch", terms: Array.from({ length: 30 }, (_, i) => `term ${i}`), appId: "42", countries: ["US"], depth: 50, force: true, maxAgeHours: 0 });
    const store = new ScreenStore();
    const r = updateJobPace(store, job.id, { searchPaceMs: 7 });
    assert.equal(r.found, true);
    assert.equal(r.effectiveSearchPaceMs, 7, "above the (zero) test floor, so it applies");
    assert.equal(job.input.searchPaceMs, 7);
    assert.equal((store.getJob(job.id)!.input as { searchPaceMs?: number }).searchPaceMs, 7);
    assert.equal(updateJobPace(store, "nope", { searchPaceMs: 1 }).found, false);
    cancelJob(store, job.id);
    await job.done;
    store.close();
  } finally {
    restore();
    cleanup();
  }
});

test("sustained 403s never fail a job: every phase waits out the backoff and retries", async () => {
  const cleanup = useTempStore();
  const origFetch = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.hostname === "search.itunes.apple.com") {
      const seed = u.searchParams.get("term")!.split(" ")[0];
      return new Response(`<plist>${hintsXml([`${seed} calculator`, `${seed} tracker`])}</plist>`, { status: 200 });
    }
    searches++;
    if (searches <= 9) return new Response("", { status: 403, headers: { "retry-after": "0" } }); // more than the old 6-strike limit
    return new Response(JSON.stringify({ resultCount: 1, results: [app(42)] }), { status: 200 });
  }) as typeof fetch;
  try {
    const job = startJob({
      kind: "screen", seeds: ["seed1", "seed2"], appId: "42", countries: ["US"], suffixes: [""], modifiers: [], exclude: [], tracked: [],
      maxCandidates: 1000, rescreenAfterDays: 0, depth: 50, expandOnly: false,
    });
    await job.done;
    assert.equal(job.status, "done", job.state.error ?? "");
    assert.equal(job.state.seedsExpanded, 2);
    assert.ok(job.state.expansionRateLimits + job.state.rateLimits >= 9, `all 403s retried (${job.state.expansionRateLimits} + ${job.state.rateLimits})`);
    assert.equal(job.state.checksFailed, 0);
    assert.equal(job.state.checksDone, job.state.checksTotal);
    assert.ok(searchLimiter.adaptiveMultiplier > 1, "the process slowed itself down");
    const store = new ScreenStore();
    assert.equal(store.jobCandidateCounts(job.id).pending ?? 0, 0, "no pending rows left behind");
    store.close();
  } finally {
    globalThis.fetch = origFetch;
    cleanup();
  }
});

test("expansion retries rate limits and skips broken queries instead of dying", async () => {
  const cleanup = useTempStore();
  const origFetch = globalThis.fetch;
  let hintCalls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    const term = u.searchParams.get("term")!;
    if (u.hostname === "search.itunes.apple.com") {
      hintCalls++;
      if (hintCalls === 1) return new Response("", { status: 403, headers: { "retry-after": "0" } });
      if (term === "bad c") return new Response("oops", { status: 500 });
      return new Response(`<plist>${hintsXml([`${term.split(" ")[0]} calculator`])}</plist>`, { status: 200 });
    }
    return new Response(JSON.stringify({ resultCount: 1, results: [app(42)] }), { status: 200 });
  }) as typeof fetch;
  try {
    const job = startJob({
      kind: "screen", seeds: ["good", "bad"], appId: "42", countries: ["US"], suffixes: ["", "c"], modifiers: [], exclude: [], tracked: [],
      maxCandidates: 100, rescreenAfterDays: 0, depth: 50, expandOnly: false,
    });
    await job.done;
    assert.equal(job.status, "done");
    assert.equal(job.state.seedsExpanded, 2);
    assert.equal(job.state.queriesDone, 4);
    assert.equal(job.state.expansionRateLimits, 1);
    assert.equal(job.state.queryErrors, 1);
    assert.ok(job.state.checksDone >= 3);
  } finally {
    globalThis.fetch = origFetch;
    cleanup();
  }
});
