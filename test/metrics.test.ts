import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsCache, top10FromCompetitors } from "../dist/metrics.js";

const now = Date.parse("2026-09-03T00:00:00Z");

test("top10FromCompetitors aggregates max/sum/avg, newest and median age, dominant genre", () => {
  const t = top10FromCompetitors(
    {
      cachedDate: "2026-09-03T20:19:03Z",
      apps: [
        { position: 2, id: 2, trackName: "B", userRatingCount: 278, averageUserRating: 4.8, releaseDate: "2020-04-29T07:00:00Z", primaryGenreName: "Health & Fitness" },
        { position: 1, id: 1, trackName: "A", userRatingCount: 281, averageUserRating: 4.8, releaseDate: "2019-07-09T07:00:00Z", primaryGenreName: "Health & Fitness" },
        { position: 3, id: 3, trackName: "C", userRatingCount: 2, averageUserRating: 5, releaseDate: "2026-07-16T08:00:00Z", primaryGenreName: "Sports" },
      ],
    },
    now,
  )!;
  assert.equal(t.maxReviews, 281);
  assert.equal(t.sumReviews, 561);
  assert.equal(t.avgRating, 4.87);
  assert.equal(t.newestAgeDays, 49);
  assert.equal(t.medianAgeDays, 2318);
  assert.equal(t.dominantGenre, "Health & Fitness");
  assert.deepEqual(t.apps.map((a) => a.name), ["A", "B", "C"]);
  assert.equal(top10FromCompetitors(null), null);
});

test("MetricsCache merges the four cache files and tolerates missing ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-"));
  writeFileSync(join(dir, "keyword_intention_cache.json"), JSON.stringify({ "plate calculator": { intention: "Discovery" } }));
  writeFileSync(join(dir, "opportunity_cache.json"), JSON.stringify({ "plate calculator:US": { cachedDate: "x", result: { realOpportunityScore: 85, difficultyScore: 29 } } }));
  writeFileSync(join(dir, "advanced_metrics_cache.json"), JSON.stringify({ "plate calculator:US": { averageRating: 3.716651, mostRecentAppAge: 49, cachedDate: "x" }, "empty:US": { cachedDate: "x" } }));
  const m = new MetricsCache(dir).forKeyword("plate calculator", "us");
  assert.equal(m.intent, "Discovery");
  assert.equal(m.opportunity?.realOpportunityScore, 85);
  assert.equal(m.advanced?.averageRating, 3.716651);
  assert.equal(m.top10, null);
  const e = new MetricsCache(dir).forKeyword("empty", "US");
  assert.equal(e.advanced, null);
  assert.equal(e.intent, null);
  rmSync(dir, { recursive: true, force: true });
});
