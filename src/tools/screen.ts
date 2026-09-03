/** Screening pipeline tools: screen, screen_results, screen_history, screen_store_status. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, failApple, withStore } from "../util.js";
import { checkRankBatch, normalizeTerm, summarizeTop10, type BatchItemResult } from "../apple.js";
import { appleLimiter } from "../ratelimit.js";
import { ScreenStore, withScreenStore } from "../screenstore.js";
import { suggestionsWithFlags } from "./appstore.js";

export const DEFAULT_SUFFIXES = ["", "calc", "c", "l", "t", "a", "p"];

/** A candidate is worth a rank check when it is not an app title and not a bare seed prefix. */
export function candidateFilter(term: string, isAppName: boolean | undefined, excluded: Set<string>): boolean {
  if (!term || isAppName) return false;
  if (excluded.has(term)) return false;
  if (term.length < 3) return false;
  return true;
}

export function registerScreenTools(server: McpServer): void {
  server.registerTool(
    "screen",
    {
      title: "Screen keyword candidates",
      description:
        "End-to-end keyword screening in one call: expand seeds through cached autocomplete (with letter suffixes and optional seed×modifier combos), normalize and dedupe, " +
        "drop app titles and terms already tracked in Altis or listed in exclude, then run a paced batch rank check and persist everything. " +
        "Returns counts plus a shortlist (ranked top 100, and weak top 10: avg rating < 4, max reviews < 50k, or median app age < 180 days). Full rows via screen_results. " +
        "Terms checked within rescreenAfterDays are reused, not refetched. A 1,000-candidate screen takes about an hour because Apple throttles at ~20 calls/min.",
      inputSchema: {
        seeds: z.array(z.string().min(1)).min(1).max(200),
        appId: z.string().describe("Numeric Apple ID or bundle id of the app to rank"),
        country: z.string().length(2).optional().default("us"),
        countries: z.array(z.string().length(2)).optional().describe("Several storefronts; overrides country"),
        suffixes: z.array(z.string()).optional().describe(`Autocomplete suffixes appended to each seed (default ${JSON.stringify(DEFAULT_SUFFIXES)})`),
        modifiers: z.array(z.string()).optional().describe("Generate seed × modifier combos (e.g. ['app','tracker'])"),
        exclude: z.array(z.string()).optional().describe("Terms to drop (case-insensitive)"),
        excludeTracked: z.boolean().optional().default(true).describe("Drop keywords already tracked in the local Altis store"),
        altisAppId: z.number().int().optional().describe("Restrict the tracked-keyword exclusion to one Altis app id"),
        maxCandidates: z.number().int().min(1).max(5000).optional().default(1000),
        rescreenAfterDays: z.number().min(0).optional().default(7).describe("Reuse stored rank checks newer than this"),
        depth: z.number().int().min(10).max(200).optional().default(200),
        paceMs: z.number().int().min(0).max(60_000).optional(),
        expandOnly: z.boolean().optional().default(false).describe("Stop after expansion/filtering; no rank checks"),
      },
    },
    async (input, extra) => {
      const store = new ScreenStore();
      try {
        const countries = (input.countries?.length ? input.countries : [input.country]).map((c) => c.toUpperCase());
        const primary = countries[0];
        const suffixes = input.suffixes ?? DEFAULT_SUFFIXES;
        const progressToken = extra._meta?.progressToken;
        const notify = (progress: number, total: number, message: string) =>
          progressToken === undefined
            ? Promise.resolve()
            : extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, total, message } }).catch(() => undefined);

        // 1. Expand seeds through autocomplete (cached).
        const seeds = [...new Set(input.seeds.map(normalizeTerm).filter(Boolean))];
        const queries: string[] = [];
        for (const seed of seeds) for (const suf of suffixes) queries.push(suf ? `${seed} ${suf}` : seed);
        const raw = new Map<string, { isAppName: boolean; fromSeed: string }>();
        let cacheHits = 0;
        let suggestionCalls = 0;
        const namesBySeed = new Map<string, string[]>();
        for (let i = 0; i < queries.length; i++) {
          const q = queries[i];
          const seed = seeds.find((s) => q === s || q.startsWith(s + " ")) ?? q;
          const res = await suggestionsWithFlags(store, q, primary, {
            signal: extra.signal,
            paceMs: input.paceMs,
            extraNames: namesBySeed.get(seed),
            // Only fetch a SERP for name detection once per seed (its first query); reuse via extraNames.
            detectAppNames: namesBySeed.has(seed) ? undefined : true,
          });
          if (res.fromCache) cacheHits += 1;
          else suggestionCalls += 1;
          if (!namesBySeed.has(seed)) namesBySeed.set(seed, store.knownAppNames(primary));
          for (const s of res.suggestions) {
            const norm = normalizeTerm(s.term);
            if (!norm) continue;
            const prev = raw.get(norm);
            raw.set(norm, { isAppName: (prev?.isAppName ?? false) || s.isAppName === true, fromSeed: prev?.fromSeed ?? seed });
          }
          await notify(i + 1, queries.length, `expand: ${q} (${res.suggestions.length} suggestions${res.fromCache ? ", cached" : ""})`);
        }
        // 2. Seed × modifier combos.
        for (const seed of seeds) for (const m of input.modifiers ?? []) {
          const norm = normalizeTerm(`${seed} ${m}`);
          if (norm && !raw.has(norm)) raw.set(norm, { isAppName: false, fromSeed: seed });
        }
        // Seeds are queries by definition, never app titles.
        for (const seed of seeds) raw.set(seed, { isAppName: false, fromSeed: seed });

        // 3. Filter.
        const excluded = new Set((input.exclude ?? []).map(normalizeTerm));
        let tracked = new Set<string>();
        if (input.excludeTracked) {
          try {
            tracked = withStore((s) => new Set([...s.trackedTexts(input.altisAppId)].map(normalizeTerm)));
          } catch {
            tracked = new Set(); // Altis absent: nothing to exclude
          }
        }
        const dropped = { appNames: [] as string[], excluded: [] as string[], tracked: [] as string[], tooShort: 0 };
        const candidates: string[] = [];
        for (const [term, meta] of raw) {
          if (meta.isAppName) dropped.appNames.push(term);
          else if (excluded.has(term)) dropped.excluded.push(term);
          else if (tracked.has(term)) dropped.tracked.push(term);
          else if (!candidateFilter(term, false, new Set())) dropped.tooShort += 1;
          else candidates.push(term);
        }
        candidates.sort();
        const truncated = Math.max(0, candidates.length - input.maxCandidates);
        const toCheck = candidates.slice(0, input.maxCandidates);

        const expansion = {
          seeds,
          queries: queries.length,
          suggestionCalls,
          cacheHits,
          rawSuggestions: raw.size,
          candidates: candidates.length,
          truncated,
          dropped: { appNames: dropped.appNames.length, excluded: dropped.excluded.length, tracked: dropped.tracked.length, tooShort: dropped.tooShort },
          droppedAppNames: dropped.appNames,
          droppedTracked: dropped.tracked,
        };
        if (input.expandOnly) return json({ appId: input.appId, countries, expansion, candidates: toCheck });

        // 4. Paced batch rank check, reusing recent rows.
        const maxAgeMs = input.rescreenAfterDays * 86_400_000;
        const { results, summary } = await checkRankBatch(toCheck, input.appId, {
          countries,
          depth: input.depth,
          paceMs: input.paceMs,
          signal: extra.signal,
          skip: (term, c) => {
            const row = store.latestRank(term, c, input.appId, maxAgeMs);
            return row
              ? ({ term, country: c, appId: input.appId, attempts: 0, position: row.position, checkedTop: row.checkedTop, topApps: row.topApps, top10: summarizeTop10(row.topApps), checkedAt: row.checkedAt, cached: true } as BatchItemResult)
              : null;
          },
          onResult: async (r, done, total) => {
            if (!(r as { cached?: boolean }).cached) store.saveRank(r, "screen");
            await notify(done, total, `rank: ${r.term} (${r.country}) → ${r.error ? "error" : r.position ?? "not in top " + r.checkedTop}`);
          },
        });

        // 5. Shortlist from the store (latest row per term carries the scoring inputs).
        const rows = store.results({ appId: input.appId, limit: 5000 }).results.filter((r) => toCheck.includes(r.term) && countries.includes(r.country));
        const ranked = rows.filter((r) => r.position !== null && r.position <= 100).sort((a, b) => a.position! - b.position!);
        const weakTop10 = rows
          .filter((r) => (r.avgRating !== null && r.avgRating < 4) || (r.maxReviews !== null && r.maxReviews < 50_000) || (r.medianAgeDays !== null && r.medianAgeDays < 180))
          .filter((r) => !ranked.includes(r));
        const errors = results.filter((r) => r.error).map((r) => ({ term: r.term, country: r.country, error: r.error }));
        return json({
          appId: input.appId,
          countries,
          expansion,
          batch: summary,
          rate: appleLimiter.status(),
          shortlist: { ranked, weakTop10 },
          errors,
          note: "Full rows: screen_results({ appId }). History per term: screen_history.",
        });
      } catch (e) {
        return failApple(e);
      } finally {
        store.close();
      }
    },
  );

  server.registerTool(
    "screen_results",
    {
      title: "Screening results",
      description:
        "Latest stored rank check per term with the scoring inputs: position, checkedTop, maxReviews, sumReviews, avgRating, newestAgeDays, medianAgeDays, dominantGenre, source, checks. " +
        "Reads the local screening store only (no Apple calls).",
      inputSchema: {
        country: z.string().length(2).optional(),
        appId: z.string().optional(),
        maxPosition: z.number().int().min(1).optional().describe("Only terms ranking at or above this position"),
        minPosition: z.number().int().min(1).optional(),
        rankedOnly: z.boolean().optional(),
        maxTop10Reviews: z.number().optional(),
        since: z.string().optional().describe("ISO timestamp"),
        orderBy: z.enum(["position", "checkedAt", "maxReviews", "medianAgeDays", "term"]).optional(),
        orderDir: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(5000).optional().default(200),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async (f) => {
      try {
        return json(await withScreenStore((s) => s.results(f)));
      } catch (e) {
        return failApple(e);
      }
    },
  );

  server.registerTool(
    "screen_history",
    {
      title: "Screening history",
      description: "Position series for one term from the screening store (every stored check, oldest first), with the top apps at each check.",
      inputSchema: {
        term: z.string(),
        country: z.string().length(2).optional().default("us"),
        appId: z.string().optional(),
        includeTopApps: z.boolean().optional().default(false),
      },
    },
    async ({ term, country, appId, includeTopApps }) => {
      try {
        const rows = await withScreenStore((s) => s.history(term, country, appId));
        return json({
          term,
          country: country.toUpperCase(),
          checks: rows.map((r) => (includeTopApps ? r : { ...r, topApps: undefined })),
        });
      } catch (e) {
        return failApple(e);
      }
    },
  );

  server.registerTool(
    "screen_store_status",
    {
      title: "Screening store status",
      description: "Location and counts of the server-owned screening store (rank checks, cached suggestion queries).",
      inputSchema: {},
    },
    async () => {
      try {
        return json(await withScreenStore((s) => s.stats()));
      } catch (e) {
        return failApple(e);
      }
    },
  );
}
