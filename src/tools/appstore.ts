/** Tools that query Apple's public App Store endpoints live (appstore_*), plus rate_status. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, fail, failApple } from "../util.js";
import { checkRank, findApp, lookupApp, searchApps } from "../apple.js";
import { rateStatus } from "../ratelimit.js";
import { withScreenStore } from "../screenstore.js";
import { suggestionsWithFlags } from "../suggest.js";
import { startDetachedJob, startJob, type BatchJobInput } from "../jobs.js";

const PACING_NOTE =
  "Search/lookup calls share one limiter (default 1.2 s apart) and autocomplete another (0.6 s); a 403/429 backs off only the endpoint that received it. See rate_status.";

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
        const { namesUsed: _names, ...out } = await withScreenStore((s) => suggestionsWithFlags(s, term, country, { refresh, detectAppNames, signal: extra.signal }));
        return json(out);
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
        "Paced rank checks for many terms (and optionally several countries). Calls go through the search limiter, 403/429 responses wait out the backoff (Retry-After honored) and retry, " +
        "and every completed term is persisted immediately to the screening store (query screen_results). Terms checked in the last 24 h are reused unless force: true. " +
        "async: true returns { jobId } at once; follow with screen_job_status. async: false (default) blocks and returns every result; use it for small runs only.",
      inputSchema: {
        terms: z.array(z.string().min(1)).min(1).max(5000),
        appId: z.string().describe("Numeric Apple ID or bundle id"),
        country: z.string().length(2).optional().describe("Single storefront (default us)"),
        countries: z.array(z.string().length(2)).optional().describe("Several storefronts; one row per term per country"),
        depth: z.number().int().min(10).max(200).optional().default(200),
        paceMs: z.number().int().min(0).max(60_000).optional().describe("Override the search limiter spacing for this job"),
        force: z.boolean().optional().default(false).describe("Re-check terms even if checked in the last 24 h"),
        maxAgeHours: z.number().min(0).optional().default(24).describe("Reuse stored results newer than this instead of refetching"),
        async: z.boolean().optional().default(false).describe("Return a jobId immediately instead of blocking"),
      },
    },
    async ({ terms, appId, country, countries, depth, paceMs, force, maxAgeHours, async: isAsync }) => {
      try {
        const list = (countries?.length ? countries : [country ?? "us"]).map((c) => c.toUpperCase());
        const jobInput: BatchJobInput = { kind: "batch", terms, appId, countries: list, depth, searchPaceMs: paceMs, force, maxAgeHours };
        if (isAsync) {
          const { id, state } = await withScreenStore((s) => startDetachedJob(jobInput, s));
          return json({ jobId: id, status: "running", checksTotal: state.checksTotal, note: "Runs in a detached worker process. Poll screen_job_status({ jobId }); results accumulate in screen_results" });
        }
        const job = startJob(jobInput);
        await job.done;
        return json({
          jobId: job.id,
          status: job.status,
          appId,
          countries: list,
          summary: { total: job.state.checksTotal, ok: job.state.checksOk, failed: job.state.checksFailed, skipped: job.state.candidatesSkipped, rateLimitHits: job.state.rateLimits, error: job.state.error },
          rate: rateStatus(),
          results: job.results.map((r) => ({
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
      }
    },
  );

  server.registerTool(
    "rate_status",
    {
      title: "Apple rate-limit status",
      description:
        "Throttle state of both Apple limiters (search/lookup and autocomplete): calls in the last minute, last 403/429 time, current backoff, and seconds until the next call is safe.",
      inputSchema: {},
    },
    async () => json(rateStatus()),
  );
}
