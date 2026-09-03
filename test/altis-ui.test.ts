import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteButtonPoint, confirmButtonPoint, dedupeAgainst, slotCheck } from "../dist/altis-ui.js";

const b = { x: 100, y: 50, width: 1200, height: 800 };

test("delete button geometry with and without the free-plan banner", () => {
  assert.deepEqual(deleteButtonPoint(b, false), { x: 1227, y: 828 });
  assert.deepEqual(deleteButtonPoint(b, true), { x: 1227, y: 738 });
  assert.deepEqual(confirmButtonPoint(b), { x: 700, y: 531 });
});

test("dedupe is case-insensitive and drops repeats within the request", () => {
  const r = dedupeAgainst(["Plate Calc", " 1rm ", "plate calc", "New", ""], ["plate calc", "old"]);
  assert.deepEqual(r.fresh, ["1rm", "New"]);
  assert.deepEqual(r.duplicates, ["Plate Calc", "plate calc"]);
});

test("slot guard", () => {
  assert.deepEqual(slotCheck(22, 8), { ok: true, after: 30, overBy: 0 });
  assert.deepEqual(slotCheck(25, 8), { ok: false, after: 33, overBy: 3 });
});
