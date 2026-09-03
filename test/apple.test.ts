import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeTop10, looksLikeAppName, rankFromResults, normalizeTerm, checkRankBatch, type AppResult } from "../dist/apple.js";
import { appleLimiter } from "../dist/ratelimit.js";

const now = Date.parse("2026-09-03T00:00:00Z");
const app = (i: number, extra: Partial<AppResult> = {}): AppResult => ({
  trackId: i,
  bundleId: `com.test.a${i}`,
  trackName: `App ${i}`,
  sellerName: "s",
  primaryGenreName: "Health & Fitness",
  trackViewUrl: "",
  ...extra,
});

test("summarizeTop10 computes max/sum/avg/ages/genre", () => {
  const s = summarizeTop10(
    [
      { userRatingCount: 281, averageUserRating: 4.8, releaseDate: "2026-07-16T00:00:00Z", primaryGenreName: "Health & Fitness" },
      { userRatingCount: 10, averageUserRating: 3.0, releaseDate: "2020-01-01T00:00:00Z", primaryGenreName: "Health & Fitness" },
      { userRatingCount: 5, averageUserRating: 4.0, releaseDate: "2024-09-03T00:00:00Z", primaryGenreName: "Sports" },
    ],
    now,
  );
  assert.equal(s.count, 3);
  assert.equal(s.maxReviews, 281);
  assert.equal(s.sumReviews, 296);
  assert.equal(s.avgRating, 3.93);
  assert.equal(s.newestAgeDays, 49);
  assert.equal(s.medianAgeDays, 730);
  assert.equal(s.dominantGenre, "Health & Fitness");
  assert.equal(summarizeTop10([]).maxReviews, null);
});

test("rankFromResults includes release dates, genre, bundleId and the summary", () => {
  const results = [app(1, { releaseDate: "2025-01-01T00:00:00Z", userRatingCount: 7 }), app(6768525538)];
  const r = rankFromResults("plate calculator", "6768525538", "us", results);
  assert.equal(r.position, 2);
  assert.equal(r.country, "US");
  assert.equal(r.topApps[0].releaseDate, "2025-01-01T00:00:00Z");
  assert.equal(r.topApps[0].bundleId, "com.test.a1");
  assert.equal(r.topApps[0].primaryGenreName, "Health & Fitness");
  assert.equal(r.top10.maxReviews, 7);
  assert.equal(rankFromResults("x", "com.test.a1", "us", results).position, 1);
  assert.equal(rankFromResults("x", "nope", "us", results).position, null);
});

test("looksLikeAppName flags titles and leaves queries alone", () => {
  const names = ["BarLoad Plate Calculator - Gym", "BarMath: Plate Calculator", "Plate Calculator Pro", "Barbell Plate Calculator", "Plate Calculator", "Plate Calculator - Weights", "Barbell Plate Calculator Pro"];
  assert.equal(looksLikeAppName("barload plate calculator", names), true);
  assert.equal(looksLikeAppName("barmath: plate calculator", names), true);
  assert.equal(looksLikeAppName("plate calculator pro", names), true);
  assert.equal(looksLikeAppName("1rm club: rep calculator & log", []), true);
  assert.equal(looksLikeAppName("plate calculator", names), false, "generic: appears inside other titles");
  assert.equal(looksLikeAppName("gym plate calculator", names), false);
  assert.equal(looksLikeAppName("weight plate calculator", names), false);
  assert.equal(normalizeTerm("1RM Club: Rep-Calc "), "1rm club rep calc");
});

test("checkRankBatch retries rate limits, records errors, honours skip and onResult", async () => {
  appleLimiter.reset();
  appleLimiter.paceMs = 0;
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    calls++;
    const term = new URL(String(url)).searchParams.get("term");
    if (term === "boom") return new Response("nope", { status: 500 });
    if (term === "throttle" && calls < 3) return new Response("", { status: 403, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ resultCount: 1, results: [app(42)] }), { status: 200 });
  }) as typeof fetch;
  try {
    const seen: string[] = [];
    const { results, summary } = await checkRankBatch(["throttle", "ok", "boom", "skipme"], "42", {
      countries: ["us", "mx"],
      maxRetries: 2,
      skip: (t) => (t === "skipme" ? { term: t, country: "US", appId: "42", attempts: 0, position: 3, checkedTop: 10, topApps: [] } : null),
      onResult: (r) => void seen.push(`${r.term}:${r.country}`),
    });
    assert.equal(summary.total, 8);
    assert.equal(summary.ok, 4);
    assert.equal(summary.failed, 2);
    assert.equal(summary.skipped, 2);
    assert.ok(summary.rateLimitHits >= 1);
    assert.equal(seen.length, 8);
    const ok = results.find((r) => r.term === "ok" && r.country === "US")!;
    assert.equal(ok.position, 1);
    const boom = results.find((r) => r.term === "boom")!;
    assert.match(boom.error!, /500/);
    assert.equal(boom.attempts, 2);
  } finally {
    globalThis.fetch = origFetch;
    appleLimiter.reset();
  }
});
