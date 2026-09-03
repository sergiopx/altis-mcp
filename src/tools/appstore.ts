/** Tools that query Apple's public App Store endpoints live (appstore_*), plus rate_status. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, fail, failApple } from "../util.js";
import { checkRank, checkRankBatch, findApp, lookupApp, looksLikeAppName, searchApps, searchHints, summarizeTop10, type BatchItemResult } from "../apple.js";
import { appleLimiter } from "../ratelimit.js";
import { DEFAULT_SUGGESTION_TTL_MS, ScreenStore, withScreenStore } from "../screenstore.js";

const PACING_NOTE = "All Apple calls share one process-wide limiter (~3 s apart, exponential backoff on 403/429); see rate_status.";

/**
 * Autocomplete with the on-disk cache and app-name flagging. One extra search
 * call (the seed's SERP) supplies app titles to match against; stored SERPs add more.
 */
export async function suggestionsWithFlags(
  store: ScreenStore,
  term: string,
  country: string,
  opts: { refresh?: boolean; detectAppNames?: boolean; ttlMs?: number; signal?: AbortSignal; paceMs?: number; extraNames?: Iterable<string> } = {},
) {
  const ttl = opts.ttlMs ?? DEFAULT_SUGGESTION_TTL_MS;
  const cached = opts.refresh ? null : store.getSuggestions(term, country, ttl);
  let raw: string[];
  let fromCache = false;
  let fetchedAt: string;
  if (cached) {
    raw = cached.suggestions;
    fromCache = true;
    fetchedAt = cached.fetchedAt;
  } else {
    raw = await searchHints(term, country, { signal: opts.signal, paceMs: opts.paceMs });
    store.saveSuggestions(term, country, raw);
    fetchedAt = new Date().toISOString();
  }
  let names: string[] = [];
  if (opts.detectAppNames !== false) {
    names = [...store.knownAppNames(country), ...(opts.extraNames ?? [])];
    if (!fromCache || !names.length) {
      try {
        const serp = await searchApps(term, country, 50, { signal: opts.signal, paceMs: opts.paceMs });
        names.push(...serp.map((a) => a.trackName));
      } catch (e) {
        if (opts.detectAppNames === true) throw e; // caller insisted; surface the rate limit
      }
    }
  }
  const suggestions = raw.map((s) => ({ term: s, isAppName: opts.detectAppNames === false ? undefined : looksLikeAppName(s, names) }));
  return { term, country: country.toUpperCase(), fromCache, fetchedAt, suggestions };
}

export function registerAppStoreTools(server: McpServer): void {
  server.registerTool(
    "appstore_search",
    {
      title: "App Store search",
      description:
        "Search the App Store for a keyword and return the ranked apps (the SERP), with ratings, review counts and release dates. " +
        "Pass targetAppId to also get that app's position in the same call (saves a separate appstore_check_rank). " +
        PACING_NOTE,
      inputSchema: {
        term: z.string(),
        country: z.string().length(2).optional().default("us"),
        limit: z.number().int().min(1).max(200).optional().default(25),
        targetAppId: z.string().optional().describe("Numeric Apple ID or bundle id; adds targetPosition/checkedTop to the output"),
      },
    },
    async ({ term, country, limit, targetAppId }, extra) => {
      try {
        const results = await searchApps(term, country, limit, { signal: extra.signal });
        const idx = targetAppId ? findApp(results, targetAppId) : -1;
        return json({
          term,
          country: country.toUpperCase(),
          resultCount: results.length,
          ...(targetAppId ? { targetAppId, targetPosition: idx >= 0 ? idx + 1 : null, checkedTop: results.length } : {}),
          results: results.map((a, i) => ({ position: i + 1, ...a })),
        });
      } catch (e) {
        return failApple(e);
      }
    },
  );

  server.registerTool(
    "appstore_lookup",
    {
      title: "App Store lookup",
      description: "Fetch an app's App Store listing by numeric Apple ID or bundle identifier, including its description. " + PACING_NOTE,
      inputSchema: {
        id: z.string().describe("Numeric Apple ID (e.g. 6768525538) or bundle id"),
        country: z.string().length(2).optional().default("us"),
      },
    },
    async ({ id, country }, extra) => {
      try {
        const app = await lookupApp(id, country, { signal: extra.signal });
        return app ? json(app) : fail(`No app found for ${id} in ${country}`);
      } catch (e) {
        return failApple(e);
      }
    },
  );

  server.registerTool(
    "appstore_suggestions",
    {
      title: "App Store search suggestions",
      description:
        "App Store search-bar autocomplete suggestions for a seed term. Responses are cached on disk for 7 days (refresh: true bypasses). " +
        "Each suggestion carries isAppName (advisory): true when it matches an app title from the seed's search results or contains a title separator like ' - ' or ': '. " +
        PACING_NOTE,
      inputSchema: {
        term: z.string(),
        country: z.string().length(2).optional().default("us"),
        refresh: z.boolean().optional().default(false).describe("Bypass the 7-day cache"),
        detectAppNames: z.boolean().optional().default(true).describe("Fetch the seed's SERP (one extra call) to flag app titles"),
      },
    },
    async ({ term, country, refresh, detectAppNames }, extra) => {
      try {
        return json(await withScreenStore((s) => suggestionsWithFlags(s, term, country, { refresh, detectAppNames, signal: extra.signal })));
      } catch (e) {
        return failApple(e);
      }
    },
  );

  server.registerTool(
    "appstore_check_rank",
    {
      title: "Check keyword rank",
      description:
        "Live check of where an app ranks in App Store search results for a term (searches the top N results). Returns the position, the top 10 competitors " +
        "(with reviews, rating, releaseDate, currentVersionReleaseDate, primaryGenreName, bundleId) and a top10 summary (maxReviews, sumReviews, avgRating, newestAgeDays, medianAgeDays, dominantGenre). " +
        "The result is persisted to the screening store (see screen_results). " + PACING_NOTE,
      inputSchema: {
        term: z.string(),
        appId: z.string().describe("Numeric Apple ID or bundle id of the app to find"),
        country: z.string().length(2).optional().default("us"),
        depth: z.number().int().min(10).max(200).optional().default(200),
      },
    },
    async ({ term, appId, country, depth }, extra) => {
      try {
        const r = await checkRank(term, appId, country, depth, { signal: extra.signal });
        await withScreenStore((s) => s.saveRank(r, "check_rank"));
        return json(r);
      } catch (e) {
        return failApple(e);
      }
    },
  );

  server.registerTool(
    "appstore_check_rank_batch",
    {
      title: "Batch keyword rank check",
      description:
        "Paced rank checks for many terms (and optionally several countries) in one call. Calls are spaced ~3 s apart, 403/429 responses wait out the backoff (Retry-After honored) and retry, " +
        "and every completed term is persisted immediately to the screening store so a crash loses nothing (query screen_results). Terms checked in the last 24 h are skipped unless force: true. " +
        "Sends MCP progress notifications when the client passes a progressToken. Long batches: 1,000 terms take about an hour.",
      inputSchema: {
        terms: z.array(z.string().min(1)).min(1).max(5000),
        appId: z.string().describe("Numeric Apple ID or bundle id"),
        country: z.string().length(2).optional().describe("Single storefront (default us)"),
        countries: z.array(z.string().length(2)).optional().describe("Several storefronts; one row per term per country"),
        depth: z.number().int().min(10).max(200).optional().default(200),
        paceMs: z.number().int().min(0).max(60_000).optional().describe("Override the minimum spacing between Apple calls"),
        force: z.boolean().optional().default(false).describe("Re-check terms even if checked in the last 24 h"),
        maxAgeHours: z.number().min(0).optional().default(24).describe("Reuse stored results newer than this instead of refetching"),
      },
    },
    async ({ terms, appId, country, countries, depth, paceMs, force, maxAgeHours }, extra) => {
      const store = new ScreenStore();
      try {
        const list = countries?.length ? countries : [country ?? "us"];
        const progressToken = extra._meta?.progressToken;
        const uniqueTerms = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
        const { results, summary } = await checkRankBatch(uniqueTerms, appId, {
          countries: list,
          depth,
          paceMs,
          signal: extra.signal,
          skip: (term, c) => {
            if (force) return null;
            const row = store.latestRank(term, c, appId, maxAgeHours * 3_600_000);
            return row
              ? { term, country: c, appId, attempts: 0, position: row.position, checkedTop: row.checkedTop, topApps: row.topApps, top10: summarizeTop10(row.topApps), checkedAt: row.checkedAt, cached: true } as BatchItemResult & { cached: boolean }
              : null;
          },
          onResult: async (r, done, total) => {
            if (!(r as { cached?: boolean }).cached) store.saveRank(r, "batch");
            if (progressToken !== undefined) {
              await extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: done, total, message: `${r.term} (${r.country}): ${r.error ? "error" : r.position ?? "not in top " + r.checkedTop}` },
                })
                .catch(() => undefined);
            }
          },
        });
        return json({
          appId,
          countries: list.map((c) => c.toUpperCase()),
          summary,
          rate: appleLimiter.status(),
          results: results.map((r) => ({
            term: r.term,
            country: r.country,
            position: r.position ?? null,
            checkedTop: r.checkedTop ?? 0,
            top10: r.top10 ?? null,
            topApps: r.topApps ?? [],
            checkedAt: r.checkedAt ?? null,
            attempts: r.attempts,
            ...((r as { cached?: boolean }).cached ? { cached: true } : {}),
            ...(r.error ? { error: r.error, rateLimited: r.rateLimited ?? false } : {}),
          })),
        });
      } catch (e) {
        return failApple(e);
      } finally {
        store.close();
      }
    },
  );

  server.registerTool(
    "rate_status",
    {
      title: "Apple rate-limit status",
      description:
        "Throttle state of the shared Apple limiter: calls per endpoint in the last minute, last 403/429 time, current backoff, and seconds until the next call is safe.",
      inputSchema: {},
    },
    async () => json(appleLimiter.status()),
  );
}
