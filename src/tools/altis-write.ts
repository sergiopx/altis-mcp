/**
 * Keyword writes into Altis through UI automation (altis_add_keywords,
 * altis_delete_keywords). Every write is guarded and verified against the store.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, fail, withStore } from "../util.js";
import {
  FREE_PLAN_LIMIT,
  activateAltis,
  addKeywordsViaUI,
  clearSelection,
  clickAt,
  confirmButtonPoint,
  dedupeAgainst,
  deleteButtonPoint,
  hasOpenSheetOrDialog,
  isAltisFrontmost,
  isAltisRunning,
  selectRow,
  selectedRowCount,
  sleep,
  slotCheck,
  windowBounds,
} from "../altis-ui.js";

async function guards(): Promise<string[]> {
  const problems: string[] = [];
  if (process.platform !== "darwin") return ["UI automation requires macOS"];
  if (!(await isAltisRunning())) return ["Altis is not running"];
  if (!(await isAltisFrontmost())) {
    await activateAltis();
    if (!(await isAltisFrontmost())) problems.push("Altis is not the frontmost app (could not activate it)");
  }
  try {
    if (await hasOpenSheetOrDialog()) problems.push("Altis has a sheet or dialog open; dismiss it first");
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  return problems;
}

function readState(appId: number) {
  return withStore((s) => {
    const app = s.getApp(appId);
    if (!app) throw new Error(`No tracked app with id ${appId} (see altis_list_apps)`);
    return { app, count: s.keywordCount(appId), tracked: s.trackedTexts(appId) };
  });
}

/** Poll the store until the app's keyword count equals `expected` or the timeout passes. */
async function waitForCount(appId: number, expected: number, timeoutMs = 6000): Promise<number> {
  const until = Date.now() + timeoutMs;
  let count = -1;
  for (;;) {
    count = withStore((s) => s.keywordCount(appId));
    if (count === expected || Date.now() > until) return count;
    await sleep(400);
  }
}

export function registerAltisWriteTools(server: McpServer): void {
  server.registerTool(
    "altis_add_keywords",
    {
      title: "Add keywords to Altis",
      description:
        `Add keywords to a tracked app in Altis through UI automation (Altis must be running and frontmost, no dialog open). Guards: case-insensitive dedupe against tracked keywords, ` +
        `${FREE_PLAN_LIMIT}-slot free-plan limit read from the store, and verification of the store count afterwards. Returns { before, after, changed, skipped }. Never writes to the SQLite store.`,
      inputSchema: {
        appId: z.number().int().describe("Altis app id from altis_list_apps"),
        keywords: z.array(z.string().min(1)).min(1).max(FREE_PLAN_LIMIT),
        country: z.string().length(2).optional().describe("Informational; Altis adds to the app's active country"),
        allowOverLimit: z.boolean().optional().default(false).describe("Skip the 30-slot guard (paid plan)"),
        dryRun: z.boolean().optional().default(false).describe("Run guards and dedupe only; click nothing"),
      },
    },
    async ({ appId, keywords, allowOverLimit, dryRun }) => {
      try {
        const { app, count: before, tracked } = readState(appId);
        const { fresh, duplicates } = dedupeAgainst(keywords, tracked);
        const slots = slotCheck(before, fresh.length);
        const plan = { app: app.name, before, toAdd: fresh, skipped: duplicates, projectedAfter: slots.after, limit: FREE_PLAN_LIMIT };
        if (!fresh.length) return json({ ...plan, after: before, changed: [], note: "Nothing to add: all keywords already tracked" });
        if (!slots.ok && !allowOverLimit) {
          return fail(`Adding ${fresh.length} keyword(s) would put the tracker at ${slots.after}, over the ${FREE_PLAN_LIMIT}-slot free plan limit by ${slots.overBy}. Delete some first or pass allowOverLimit.`);
        }
        const problems = await guards();
        if (problems.length) return fail(`Refusing to write: ${problems.join("; ")}`);
        if (dryRun) return json({ ...plan, dryRun: true });

        await addKeywordsViaUI(fresh.join(", "));
        const after = await waitForCount(appId, before + fresh.length);
        const nowTracked = withStore((s) => s.trackedTexts(appId));
        const changed = fresh.filter((k) => nowTracked.has(k.toLowerCase()));
        const missing = fresh.filter((k) => !nowTracked.has(k.toLowerCase()));
        const ok = after === before + fresh.length && missing.length === 0;
        return ok
          ? json({ ...plan, after, changed })
          : fail(JSON.stringify({ error: `Store count is ${after}, expected ${before + fresh.length}; some keywords may not have been added`, before, after, changed, missing }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "altis_delete_keywords",
    {
      title: "Delete keywords from Altis",
      description:
        "Delete keywords from a tracked app in Altis through UI automation, one at a time: clear selection, select exactly that row, click 'Delete Selected' (coordinate click), confirm, " +
        "then verify the store count dropped by exactly 1 before continuing. Stops at the first anomaly. Altis must be running and frontmost with no dialog open. Returns { before, after, changed, notFound }.",
      inputSchema: {
        appId: z.number().int().describe("Altis app id from altis_list_apps"),
        keywords: z.array(z.string().min(1)).min(1).max(100),
        dryRun: z.boolean().optional().default(false).describe("Run guards and matching only; click nothing"),
      },
    },
    async ({ appId, keywords, dryRun }) => {
      try {
        const { app, count: before, tracked } = readState(appId);
        const wanted = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))];
        const present = wanted.filter((k) => tracked.has(k));
        const notFound = wanted.filter((k) => !tracked.has(k));
        const plan = { app: app.name, before, toDelete: present, notFound, projectedAfter: before - present.length };
        if (!present.length) return json({ ...plan, after: before, changed: [], note: "Nothing to delete: none of the keywords are tracked" });
        const problems = await guards();
        if (problems.length) return fail(`Refusing to write: ${problems.join("; ")}`);
        if (dryRun) return json({ ...plan, dryRun: true });

        const changed: string[] = [];
        let current = before;
        for (const kw of present) {
          if (await hasOpenSheetOrDialog()) return fail(JSON.stringify({ error: "A dialog opened unexpectedly; stopping", before, after: current, changed }));
          await clearSelection();
          if (!(await selectRow(kw))) return fail(JSON.stringify({ error: `Row '${kw}' not found in the UI`, before, after: current, changed }));
          const selected = await selectedRowCount();
          if (selected !== 1) return fail(JSON.stringify({ error: `Expected exactly 1 selected row, found ${selected}`, before, after: current, changed }));
          const bounds = await windowBounds();
          const bannerVisible = current > FREE_PLAN_LIMIT;
          await clickAt(deleteButtonPoint(bounds, bannerVisible));
          await clickAt(confirmButtonPoint(bounds));
          const after = await waitForCount(appId, current - 1);
          if (after !== current - 1) {
            return fail(JSON.stringify({ error: `Deleting '${kw}' changed the count from ${current} to ${after} (expected ${current - 1}); stopping`, before, after, changed }));
          }
          current = after;
          changed.push(kw);
        }
        return json({ ...plan, after: current, changed });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
