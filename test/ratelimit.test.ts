import { test } from "node:test";
import assert from "node:assert/strict";
import { AppleRateLimiter, DEFAULT_SEARCH_PACE_MS, SUCCESSES_TO_RESET, parseRetryAfter } from "../dist/ratelimit.js";

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    sleeps,
  };
}

test("parseRetryAfter handles seconds and HTTP dates", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  assert.equal(parseRetryAfter("120", now), 120);
  assert.equal(parseRetryAfter("Thu, 03 Sep 2026 12:01:00 GMT", now), 60);
  assert.equal(parseRetryAfter("garbage", now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test("acquire paces calls by the minimum interval", async () => {
  const c = fakeClock();
  const l = new AppleRateLimiter({ paceMs: 3000, now: c.now, sleep: c.sleep });
  await l.acquire("search");
  await l.acquire("search");
  assert.deepEqual(c.sleeps, [3000]);
  assert.equal(l.status().callsLastMinute.search, 2);
});

test("rate limit arms exponential backoff, Retry-After wins, ladder resets only after N clean calls", async () => {
  const c = fakeClock();
  const l = new AppleRateLimiter({ paceMs: 0, now: c.now, sleep: c.sleep, initialBackoffMs: 60_000 });
  assert.equal(l.recordRateLimit("search", 403, null), 60);
  assert.equal(l.status().currentBackoffSeconds, 60);
  await l.acquire("search");
  assert.deepEqual(c.sleeps, [60_000]);
  assert.equal(l.recordRateLimit("search", 403, null), 120);
  assert.equal(l.recordRateLimit("search", 429, "5"), 5);
  c.advance(5_000);
  for (let i = 0; i < SUCCESSES_TO_RESET - 1; i++) l.recordSuccess("search");
  assert.equal(l.status().consecutiveRateLimits, 3, "one success short: ladder still armed");
  assert.equal(l.status().successesSinceRateLimit, SUCCESSES_TO_RESET - 1);
  l.recordSuccess("search");
  assert.equal(l.status().consecutiveRateLimits, 0);
  assert.equal(l.status().nextBackoffSeconds, 60);
});

test("backoff is capped at 300 s by default", () => {
  const c = fakeClock();
  const l = new AppleRateLimiter({ now: c.now, sleep: c.sleep });
  let last = 0;
  for (let i = 0; i < 8; i++) last = l.recordRateLimit("search", 403, null);
  assert.equal(last, 300);
  assert.equal(DEFAULT_SEARCH_PACE_MS, 1500);
});

test("adaptive pace: each 403 raises the floor 50%, capped at 4x, for the rest of the process", async () => {
  const c = fakeClock();
  const l = new AppleRateLimiter({ paceMs: 1000, now: c.now, sleep: c.sleep, initialBackoffMs: 0 });
  assert.equal(l.effectivePace(), 1000);
  l.recordRateLimit("search", 403, "0");
  assert.equal(l.effectivePace(), 1500);
  l.recordRateLimit("search", 403, "0");
  assert.equal(l.effectivePace(), 2250);
  for (let i = 0; i < 10; i++) l.recordRateLimit("search", 403, "0");
  assert.equal(l.effectivePace(), 4000, "capped at 4x");
  for (let i = 0; i < 20; i++) l.recordSuccess("search");
  assert.equal(l.effectivePace(), 4000, "successes reset the ladder, not the multiplier");
  assert.equal(l.status().adaptiveMultiplier, 4);
  assert.equal(l.status().effectivePaceMs, 4000);
  // acquire paces by the effective pace
  await l.acquire("search");
  await l.acquire("search");
  assert.equal(c.sleeps.at(-1), 4000);
});

test("per-call pace can only raise the floor, never lower it", async () => {
  const c = fakeClock();
  const l = new AppleRateLimiter({ paceMs: 1500, now: c.now, sleep: c.sleep });
  assert.equal(l.effectivePace(500), 1500);
  assert.equal(l.effectivePace(3200), 3200);
  await l.acquire("search", { paceMs: 500 });
  await l.acquire("search", { paceMs: 500 });
  assert.deepEqual(c.sleeps, [1500]);
  await l.acquire("search", { paceMs: 3200 });
  assert.equal(c.sleeps.at(-1), 3200);
});

test("acquire respects abort", async () => {
  const c = fakeClock();
  const l = new AppleRateLimiter({ paceMs: 1000, now: c.now, sleep: c.sleep });
  const ac = new AbortController();
  ac.abort();
  await l.acquire("search");
  await assert.rejects(l.acquire("search", { signal: ac.signal }));
});

test("limiters are independent: a 403 on search does not slow autocomplete", async () => {
  const { searchLimiter, suggestLimiter, rateStatus } = await import("../dist/ratelimit.js");
  searchLimiter.reset();
  suggestLimiter.reset();
  searchLimiter.recordRateLimit("search", 403, null);
  const st = rateStatus();
  assert.equal(st.search.currentBackoffSeconds, 60);
  assert.equal(st.autocomplete.currentBackoffSeconds, 0);
  assert.equal(st.autocomplete.nextSafeCallInSeconds, 0);
  searchLimiter.reset();
});
