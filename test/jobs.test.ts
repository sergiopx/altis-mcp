import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJob, jobStatus, cancelJob, listJobs, STALE_MS } from "../dist/jobs.js";
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

test("screen job pipelines: rank checks start before expansion finishes", async () => {
  const cleanup = useTempStore();
  const log: string[] = [];
  const restore = mockApple({ hintDelayMs: 15, log });
  try {
    const job = startJob({
      kind: "screen", seeds: ["plate", "barbell", "wendler", "squat"], appId: "42", countries: ["US"], suffixes: ["", "c"], modifiers: [], exclude: ["squat tracker"],
      tracked: ["plate calculator"], maxCandidates: 100, rescreenAfterDays: 7, depth: 50, expandOnly: false,
    });
    assert.equal(job.status, "running");
    // Wait until at least one rank check completed while expansion is still going.
    const until = Date.now() + 5000;
    while (Date.now() < until && !(job.state.checksDone > 0 && job.state.seedsExpanded < job.state.seedsTotal)) await new Promise((r) => setTimeout(r, 5));
    assert.ok(job.state.checksDone > 0, "a check ran");
    assert.ok(job.state.seedsExpanded < job.state.seedsTotal, `expansion still running (${job.state.seedsExpanded}/${job.state.seedsTotal})`);
    await job.done;
    assert.equal(job.status, "done");
    const s = job.state;
    assert.equal(s.seedsExpanded, 4);
    assert.equal(s.queriesDone, 8);
    assert.ok(s.dropped.appNames >= 4, "title-looking suggestions dropped");
    assert.equal(s.dropped.tracked, 1);
    assert.equal(s.dropped.excluded, 1);
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

test("sustained search rate limiting aborts the whole screen job, including expansion", async () => {
  const cleanup = useTempStore();
  const origFetch = globalThis.fetch;
  let hints = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.hostname === "search.itunes.apple.com") {
      hints++;
      await new Promise((r) => setTimeout(r, 5));
      const seed = u.searchParams.get("term")!.split(" ")[0];
      return new Response(`<plist>${hintsXml([`${seed} calculator`, `${seed} tracker`])}</plist>`, { status: 200 });
    }
    return new Response("", { status: 403, headers: { "retry-after": "0" } });
  }) as typeof fetch;
  try {
    const job = startJob({
      kind: "screen", seeds: Array.from({ length: 40 }, (_, i) => `seed${i}`), appId: "42", countries: ["US"], suffixes: ["", "c"], modifiers: [], exclude: [], tracked: [],
      maxCandidates: 1000, rescreenAfterDays: 0, depth: 50, expandOnly: false,
    });
    await job.done;
    assert.equal(job.status, "aborted");
    assert.ok(job.state.seedsExpanded < 40, `expansion stopped early (${job.state.seedsExpanded})`);
    const store = new ScreenStore();
    assert.equal(store.jobCandidateCounts(job.id).pending ?? 0, 0, "no pending rows left behind");
    store.close();
  } finally {
    globalThis.fetch = origFetch;
    cleanup();
  }
});
