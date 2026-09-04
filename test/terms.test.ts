import { test } from "node:test";
import assert from "node:assert/strict";
import { containsPhrase, defaultIncludeAny, matchesAny, words } from "../dist/terms.js";

test("whole-word phrase matching", () => {
  assert.equal(containsPhrase("pay by plate chicago", "plate"), true);
  assert.equal(containsPhrase("template maker", "plate"), false, "substring is not a word");
  assert.equal(containsPhrase("barbell plate calc", "plate calc"), true);
  assert.equal(containsPhrase("plate math calc", "plate calc"), false, "phrase words must be contiguous");
  assert.equal(containsPhrase("Wendler 5/3/1", "5 3 1"), true, "punctuation splits words");
  assert.equal(containsPhrase("plate", ""), false);
  assert.equal(matchesAny("license plate lookup", ["barcode", "plate"]), true);
  assert.equal(matchesAny("license plate lookup", []), false);
  assert.deepEqual(words("1RM  Calculator!"), ["1rm", "calculator"]);
});

test("default includeAny: seed words of 3+ chars minus stop words, numbers kept", () => {
  assert.deepEqual(defaultIncludeAny(["plate calculator", "wendler 531 app", "1rm", "the best app for me"]), ["plate", "calculator", "wendler", "531", "1rm"]);
});
