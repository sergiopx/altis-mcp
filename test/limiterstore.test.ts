import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleRateLimiter } from "../dist/ratelimit.js";
import { SqliteLimiterBackend } from "../dist/limiterstore.js";

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), advance: (ms: number) => (t += ms), sleeps };
}

test("two processes share one Apple budget through the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limiter-"));
  const path = join(dir, "screen.sqlite");
  try {
    const c = fakeClock();
    // Two limiters with separate memory (two processes) and separate connections to the same file.
    const a = new AppleRateLimiter({ name: "search", paceMs: 1000, now: c.now, sleep: c.sleep });
    const b = new AppleRateLimiter({ name: "search", paceMs: 1000, now: c.now, sleep: c.sleep });
    const ba = new SqliteLimiterBackend(path);
    const bb = new SqliteLimiterBackend(path);
    a.attach(ba);
    b.attach(bb);
    await a.acquire("search");
    assert.deepEqual(c.sleeps, [], "first call goes straight through");
    await b.acquire("search");
    assert.deepEqual(c.sleeps, [1000], "second process waits the full pace even though it never called before");
    assert.equal(a.status().shared, true);

    // A 403 seen by one process slows the other: backoff and multiplier travel through the store.
    b.recordRateLimit("search", 403, null);
    assert.equal(b.effectivePace(), 1500);
    c.advance(70_000);
    await a.acquire("search");
    assert.equal(a.status().adaptiveMultiplier, 1.5, "process A adopted the shared multiplier");
    assert.equal(a.status().consecutiveRateLimits, 1);

    // Backend lost: the limiter keeps working on local state.
    ba.close();
    await a.acquire("search");
    assert.ok(c.sleeps.length >= 2);
    bb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim is atomic: a slot taken at time t blocks another claim until t + pace", () => {
  const dir = mkdtempSync(join(tmpdir(), "limiter-"));
  try {
    const be = new SqliteLimiterBackend(join(dir, "screen.sqlite"));
    const t = 5_000_000;
    assert.equal(be.claim("search", 1500, t).ok, true);
    const second = be.claim("search", 1500, t + 100);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.nextSafeAt, t + 1500);
    assert.equal(be.claim("search", 1500, t + 1500).ok, true);
    // backoff recorded by anyone blocks everyone
    be.update("search", { backoffUntil: t + 60_000, consecutive: 1, lastRateLimitAt: t + 1600, multiplier: 1.5 });
    const blocked = be.claim("search", 1500, t + 3000);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.nextSafeAt, t + 60_000);
    // an explicit reset to 0 is allowed; a stale smaller value is not
    be.update("search", { backoffUntil: t + 10 });
    assert.equal(be.read("search").backoffUntil, t + 60_000);
    be.update("search", { backoffUntil: 0, consecutive: 0 });
    assert.equal(be.read("search").backoffUntil, 0);
    assert.equal(be.read("search").multiplier, 1.5, "multiplier persists");
    be.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
