import { test } from "node:test";
import assert from "node:assert/strict";
import { AppleRateLimiter, parseRetryAfter } from "../dist/ratelimit.js";

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

test("rate limit arms exponential backoff, Retry-After wins, success resets", async () => {
  const c = fakeClock();
  const l = new AppleRateLimiter({ paceMs: 0, now: c.now, sleep: c.sleep, initialBackoffMs: 60_000 });
  assert.equal(l.recordRateLimit("search", 403, null), 60);
  assert.equal(l.status().currentBackoffSeconds, 60);
  await l.acquire("search");
  assert.deepEqual(c.sleeps, [60_000]);
  assert.equal(l.recordRateLimit("search", 403, null), 120);
  assert.equal(l.recordRateLimit("search", 429, "5"), 5);
  l.recordSuccess("search");
  assert.equal(l.status().currentBackoffSeconds, 0);
  assert.equal(l.status().consecutiveRateLimits, 0);
  assert.equal(l.status().nextBackoffSeconds, 60);
});

test("backoff is capped", () => {
  const c = fakeClock();
  const l = new AppleRateLimiter({ now: c.now, sleep: c.sleep, initialBackoffMs: 60_000, maxBackoffMs: 600_000 });
  let last = 0;
  for (let i = 0; i < 8; i++) last = l.recordRateLimit("search", 403, null);
  assert.equal(last, 600);
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
