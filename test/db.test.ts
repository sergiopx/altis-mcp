import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotStore } from "../dist/db.js";

test("snapshot sees rows that only exist in the WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "waltest-"));
  const live = join(dir, "default.store");
  const writer = new DatabaseSync(live);
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x INTEGER);");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.exec("INSERT INTO t VALUES (1), (2), (3)");
  assert.ok(existsSync(live + "-wal"));

  // Main file alone: the rows are only in the WAL.
  const mainOnly = mkdtempSync(join(tmpdir(), "waltest-main-"));
  const { copyFileSync } = await_import();
  copyFileSync(live, join(mainOnly, "default.store"));
  const stale = new DatabaseSync(join(mainOnly, "default.store"));
  assert.equal((stale.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c, 0);
  stale.close();

  const snap = snapshotStore(live);
  assert.equal(snap.wal.copied, true);
  assert.ok(snap.wal.walBytes > 0);
  const fresh = new DatabaseSync(snap.copyPath);
  assert.equal((fresh.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c, 3);
  fresh.close();
  writer.close();
  rmSync(snap.dir, { recursive: true, force: true });
  rmSync(mainOnly, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

function await_import() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { copyFileSync: (process.getBuiltinModule("node:fs") as typeof import("node:fs")).copyFileSync };
}
