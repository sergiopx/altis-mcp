import { test } from "node:test";
import assert from "node:assert/strict";
import { ScreenStore } from "../dist/screenstore.js";

const top = (name: string, reviews: number, date: string) => ({
  position: 1, trackId: 1, bundleId: "b", trackName: name, primaryGenreName: "Health & Fitness", userRatingCount: reviews, averageUserRating: 4.5, releaseDate: date,
});

test("rank checks: latest per term, history, filters, known names", () => {
  const s = new ScreenStore(":memory:");
  const base = { appId: "42", checkedTop: 200, topApps: [top("Barbell Plate Calculator", 281, "2019-07-09T07:00:00Z")] };
  s.saveRank({ ...base, term: "Plate Calculator", country: "us", position: 165, checkedAt: "2026-09-01T00:00:00Z" } as never, "batch");
  s.saveRank({ ...base, term: "plate calculator", country: "US", position: 150, checkedAt: "2026-09-03T00:00:00Z" } as never, "screen");
  s.saveRank({ ...base, term: "wendler log 531", country: "US", position: 42, checkedAt: "2026-09-03T00:00:00Z" } as never, "screen");
  s.saveRank({ ...base, term: "nothing", country: "US", position: null, checkedAt: "2026-09-03T00:00:00Z" } as never, "screen");
  s.saveRank({ term: "broken", country: "US", appId: "42", attempts: 3, error: "Apple API 500" } as never, "batch");

  const latest = s.latestRank("PLATE CALCULATOR", "us", "42")!;
  assert.equal(latest.position, 150);
  assert.equal(s.latestRank("plate calculator", "us", "42", 1000), null, "too old for a 1 s max age");
  assert.equal(s.history("plate calculator", "US").length, 2);

  const all = s.results({ appId: "42" });
  assert.equal(all.total, 3);
  assert.deepEqual(all.results.map((r) => r.term), ["wendler log 531", "plate calculator", "nothing"]);
  assert.equal(all.results[1].checks, 2);
  assert.equal(all.results[0].maxReviews, 281);
  assert.equal(s.results({ maxPosition: 100 }).total, 1);
  assert.equal(s.results({ rankedOnly: true }).total, 2);
  assert.deepEqual([...s.checkedTerms("42", "US")].sort(), ["nothing", "plate calculator", "wendler log 531"]);
  assert.deepEqual(s.knownAppNames("US"), ["Barbell Plate Calculator"]);
  s.close();
});

test("suggestion cache honours TTL and refresh", () => {
  const s = new ScreenStore(":memory:");
  assert.equal(s.getSuggestions("plate c", "us"), null);
  s.saveSuggestions("Plate C", "US", ["plate calculator", "plate calc"]);
  assert.deepEqual(s.getSuggestions("plate c", "us")!.suggestions, ["plate calculator", "plate calc"]);
  assert.equal(s.getSuggestions("plate c", "us", -1), null);
  assert.equal(s.stats().cachedSuggestionQueries, 1);
  s.close();
});
