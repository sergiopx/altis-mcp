#!/usr/bin/env node
/** Detached job worker: `node dist/worker.js <jobId>`. Spawned by startDetachedJob. */
import { runWorker } from "./jobs.js";

const id = process.argv[2];
if (!id) {
  process.stderr.write("usage: worker.js <jobId>\n");
  process.exit(2);
}
runWorker(id).then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  },
);
