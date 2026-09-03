import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMetadata, tokenize } from "../dist/metadata.js";

const draft = {
  title: "LoadPR: Plate Calculator & 1RM",
  subtitle: "Barbell Math & Wendler 531 Log",
  keywords: "one,rep,max,calc,chart,app,loader,loading,weight,lifting,powerlifting,strength,squat,deadlift,bench",
};

test("2026-09-03 draft: 30/30/99 and coverage gaps", () => {
  const r = checkMetadata({
    ...draft,
    trackedKeywords: ["plate calculator", "1rm calculator", "barbell plate calculator", "bench press calculator", "lift percentage calculator", "wendler 531 log"],
  });
  assert.equal(r.fields.title.length, 30);
  assert.equal(r.fields.subtitle.length, 30);
  assert.equal(r.fields.keywords.length, 99);
  assert.ok(r.fields.title.ok && r.fields.subtitle.ok && r.fields.keywords.ok);
  const notCovered = r.coverage.filter((c) => !c.covered);
  assert.deepEqual(notCovered.map((c) => c.keyword), ["bench press calculator", "lift percentage calculator"]);
  assert.deepEqual(notCovered[0].missingWords, ["press"]);
  assert.deepEqual(notCovered[1].missingWords, ["lift", "percentage"]);
  assert.equal(r.duplicateWords.length, 0);
  assert.equal(r.summary.covered, 4);
});

test("limits, duplicates, spaces and stop words are reported", () => {
  const r = checkMetadata({
    title: "My Plate Calculator For Lifters!!",
    subtitle: "Plate math and the barbell",
    keywords: "plate, calc,,lift ,lift",
    trackedKeywords: ["the plate calc"],
  });
  assert.equal(r.fields.title.ok, false);
  assert.ok(r.duplicateWords.some((d) => d.word === "plate" && d.fields.length === 3));
  assert.equal(r.keywordField.emptyEntries, 1);
  assert.deepEqual(r.keywordField.entriesWithSpacesAroundCommas, ["calc", "lift"]);
  assert.deepEqual(r.keywordField.duplicateEntries, ["lift"]);
  assert.deepEqual(r.keywordField.entriesRepeatingTitleOrSubtitle, ["plate"]);
  assert.ok(r.stopWordsFound.some((s) => s.word === "my"));
  assert.equal(r.coverage[0].covered, true);
  assert.deepEqual(r.coverage[0].ignoredStopWords, ["the"]);
  assert.equal(r.summary.ok, false);
  assert.deepEqual(tokenize("Barbell Math & Wendler-531"), ["barbell", "math", "wendler", "531"]);
});
