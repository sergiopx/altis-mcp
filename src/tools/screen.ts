/** Screening pipeline tools: screen, screen_candidates, screen_job_status, screen_job_update, screen_job_cancel, screen_jobs, screen_results, screen_history, screen_store_status. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, fail, failApple, withStore } from "../util.js";
import { rateStatus, searchLimiter } from "../ratelimit.js";
import { defaultIncludeAny } from "../terms.js";
import { withScreenStore } from "../screenstore.js";
import { DEFAULT_SUFFIXES, cancelJob, jobStatus, listJobs, reconcileRunning, startDetachedJob, startJob, updateJobPace, type ScreenJobInput } from "../jobs.js";

export function registerScreenTools(server: McpServer): void {
  server.registerTool(
    "screen",
    {
      title: "Screen keyword candidates",
      description:
        "End-to-end keyword screening as a background job. Phase 1 expands every seed through cached autocomplete (letter suffixes, optional seed×modifier combos), normalizes, dedupes, " +
        "drops app titles, tracked keywords, exclude phrases and terms containing none of includeAny (default: the seed words), and stores every candidate (screen_candidates). " +
        "Phase 2 applies maxCandidates to the whole pool: seeds, then autocomplete suggestions, then combos, round-robin across seeds; the rest are kept as truncated. " +
        "Phase 3 rank-checks the selection; every result is persisted immediately. A 403 never fails the job: it waits out the backoff and retries. " +
        "Default async: true returns { jobId } at once; poll screen_job_status, read screen_results({ appId }) any time, screen_job_update to change pacing, screen_job_cancel to stop. " +
        "async: false blocks and returns the shortlist (small runs only). Candidates checked within rescreenAfterDays are reused without an Apple call.",
      inputSchema: {
        seeds: z.array(z.string().min(1)).min(1).max(2000),
        appId: z.string().describe("Numeric Apple ID or bundle id of the app to rank"),
        country: z.string().length(2).optional().default("us"),
        countries: z.array(z.string().length(2)).optional().describe("Several storefronts; overrides country"),
        suffixes: z.array(z.string()).optional().describe(`Autocomplete suffixes appended to each seed (default ${JSON.stringify(DEFAULT_SUFFIXES)})`),
        modifiers: z.array(z.string()).optional().describe("Generate seed × modifier combos (e.g. ['app','tracker'])"),
        exclude: z.array(z.string()).optional().describe("Whole-word phrases to drop, case-insensitive ('plate' drops 'pay by plate chicago' but not 'template')"),
        includeAny: z.array(z.string()).optional().describe("A candidate must contain at least one of these words (whole-word). Default: every seed word of 3+ letters minus stop words. Pass [] to disable"),
        excludeTracked: z.boolean().optional().default(true).describe("Drop keywords already tracked in the local Altis store"),
        altisAppId: z.number().int().optional().describe("Restrict the tracked-keyword exclusion to one Altis app id"),
        maxCandidates: z.number().int().min(1).max(20000).optional().default(1000),
        rescreenAfterDays: z.number().min(0).optional().default(7).describe("Reuse stored rank checks newer than this"),
        depth: z.number().int().min(10).max(200).optional().default(200),
        searchPaceMs: z.number().int().min(0).max(60_000).optional().describe("Spacing between search calls for this job. Can only raise the limiter floor (default 1500 ms × adaptive multiplier), never lower it"),
        suggestPaceMs: z.number().int().min(0).max(60_000).optional().describe("Spacing between autocomplete calls for this job (floor 600 ms)"),
        expandOnly: z.boolean().optional().default(false).describe("Stop after expansion/filtering; no rank checks"),
        async: z.boolean().optional().default(true).describe("Return a jobId immediately (default) or block until done"),
      },
    },
    async (input) => {
      try {
        const countries = (input.countries?.length ? input.countries : [input.country]).map((c) => c.toUpperCase());
        let tracked: string[] = [];
        if (input.excludeTracked) {
          try {
            tracked = withStore((s) => [...s.trackedTexts(input.altisAppId)]);
          } catch {
            tracked = []; // Altis absent: nothing to exclude
          }
        }
        const includeAny = input.includeAny ?? defaultIncludeAny(input.seeds);
        const jobInput: ScreenJobInput = {
          kind: "screen",
          seeds: input.seeds,
          appId: input.appId,
          countries,
          suffixes: input.suffixes ?? DEFAULT_SUFFIXES,
          modifiers: input.modifiers ?? [],
          exclude: input.exclude ?? [],
          includeAny,
          tracked,
          maxCandidates: input.maxCandidates,
          rescreenAfterDays: input.rescreenAfterDays,
          depth: input.depth,
          searchPaceMs: input.searchPaceMs,
          suggestPaceMs: input.suggestPaceMs,
          expandOnly: input.expandOnly,
        };
        if (input.async) {
          const { id, state } = await withScreenStore((s) => startDetachedJob(jobInput, s));
          return json({
            jobId: id,
            status: "running",
            seedsTotal: state.seedsTotal,
            queriesTotal: state.queriesTotal,
            includeAny,
            searchPaceMs: { requested: input.searchPaceMs ?? null, effective: state.effectiveSearchPaceMs },
            note: "Runs in a detached worker process. Poll screen_job_status({ jobId }); candidates appear in screen_candidates({ jobId }) during expansion, results in screen_results({ appId }) during checking.",
          });
        }
        const job = startJob(jobInput);
        await job.done;
        const st = job.snapshot();
        if (input.expandOnly) {
          const listed = await withScreenStore((s) => s.listJobCandidates(job.id, { limit: 20000 }));
          return json({ jobId: job.id, status: job.status, appId: input.appId, countries, progress: st, rate: rateStatus(), ...listed, note: "Paged view: screen_candidates({ jobId })" });
        }
        const rows = await withScreenStore((s) => s.results({ appId: input.appId, limit: 20000 }).results);
        const mine = new Set(job.results.map((r) => `${r.term}|${r.country}`));
        const got = rows.filter((r) => mine.has(`${r.term}|${r.country}`));
        const ranked = got.filter((r) => r.position !== null && r.position <= 100).sort((a, b) => a.position! - b.position!);
        const weakTop10 = got
          .filter((r) => (r.avgRating !== null && r.avgRating < 4) || (r.maxReviews !== null && r.maxReviews < 50_000) || (r.medianAgeDays !== null && r.medianAgeDays < 180))
          .filter((r) => !ranked.includes(r));
        return json({
          jobId: job.id,
          status: job.status,
          appId: input.appId,
          countries,
          progress: st,
          rate: rateStatus(),
          shortlist: { ranked, weakTop10 },
          errors: job.results.filter((r) => r.error).map((r) => ({ term: r.term, country: r.country, error: r.error })),
          note: "Full rows: screen_results({ appId }). History per term: screen_history.",
        });
      } catch (e) {
        return failApple(e);
      }
    },
  );

  server.registerTool(
    "screen_candidates",
    {
      title: "Screening job candidates",
      description:
        "Candidates of a screen job with source (seed | autocomplete | combo), seed, status and position. Statuses: candidate (selected, no check requested), truncated (cut by maxCandidates), " +
        "pending, skipped (fresh stored check reused), done, error, cancelled. Also returns counts by status and, for truncated, per seed. Local store only; available while the job runs.",
      inputSchema: {
        jobId: z.string(),
        status: z.enum(["candidate", "truncated", "pending", "skipped", "done", "error", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(20000).optional().default(500),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async ({ jobId, status, limit, offset }) => {
      try {
        const v = await withScreenStore((s) => {
          if (!s.getJob(jobId)) return null;
          return { jobId, counts: s.jobCandidateCounts(jobId), truncatedBySeed: s.candidateCountsBySeed(jobId, "truncated"), ...s.listJobCandidates(jobId, { status, limit, offset }) };
        });
        return v ? json(v) : fail(`No job ${jobId}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "screen_job_update",
    {
      title: "Update screening job pacing",
      description:
        "Change the search and/or autocomplete spacing of a running screen or batch job without cancelling it. Works across server processes (the worker picks it up before its next Apple call). " +
        "The limiter floor still applies, so a value below it only removes an earlier slow-down. Returns the effective paces.",
      inputSchema: {
        jobId: z.string(),
        searchPaceMs: z.number().int().min(0).max(60_000).optional(),
        suggestPaceMs: z.number().int().min(0).max(60_000).optional(),
      },
    },
    async ({ jobId, searchPaceMs, suggestPaceMs }) => {
      try {
        const patch: { searchPaceMs?: number; suggestPaceMs?: number } = {};
        if (searchPaceMs !== undefined) patch.searchPaceMs = searchPaceMs;
        if (suggestPaceMs !== undefined) patch.suggestPaceMs = suggestPaceMs;
        if (!Object.keys(patch).length) return fail("Pass searchPaceMs and/or suggestPaceMs");
        const r = await withScreenStore((s) => updateJobPace(s, jobId, patch));
        return r.found ? json({ jobId, ...r, limiterFloorMs: Math.round(searchLimiter.effectivePace()) }) : fail(`No job ${jobId}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "screen_job_status",
    {
      title: "Screening job status",
      description:
        "Progress of a screen or batch job: phase (expanding / selecting / checking / finished), seedsExpanded/seedsTotal, candidatesFound, candidatesTruncated (and truncatedBySeed), checksDone/checksTotal, " +
        "rateLimits, backoffSeconds, effectiveSearchPaceMs, etaSeconds, " +
        "and the last 10 completed checks. Works for jobs started by another server process (owner: other-process) and for finished or aborted jobs after a restart.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      try {
        const v = await withScreenStore((s) => {
          const view = jobStatus(s, jobId);
          return view ? { ...view, candidates: s.jobCandidateCounts(jobId) } : null;
        });
        return v ? json(v) : fail(`No job ${jobId}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "screen_job_cancel",
    {
      title: "Cancel screening job",
      description: "Stop a running screen or batch job after its current Apple call. Completed checks stay in the store. Works across server processes. This is the only way a job stops on sustained 403s: jobs wait out backoffs indefinitely.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      try {
        const r = await withScreenStore((s) => cancelJob(s, jobId));
        return r.found ? json({ jobId, ...r }) : fail(`No job ${jobId}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "screen_jobs",
    {
      title: "List screening jobs",
      description: "Recent screen and batch jobs with status and progress, newest first.",
      inputSchema: {
        status: z.enum(["running", "done", "aborted", "cancelled", "failed"]).optional(),
        limit: z.number().int().min(1).max(200).optional().default(20),
      },
    },
    async ({ status, limit }) => {
      try {
        return json(await withScreenStore((s) => listJobs(s, status, limit).map((v) => ({ ...v, input: undefined, progress: { ...v.progress, recent: undefined } }))));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "screen_results",
    {
      title: "Screening results",
      description:
        "Latest stored rank check per term with the scoring inputs: position, checkedTop, maxReviews, sumReviews, avgRating, newestAgeDays, medianAgeDays, dominantGenre, source, checks. " +
        "Also reports how many terms are still pending in running jobs. Reads the local screening store only (no Apple calls).",
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
        return json(await withScreenStore((s) => (reconcileRunning(s), { pending: s.pendingSummary(), ...s.results(f) })));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "screen_history",
    {
      title: "Screening history",
      description: "Position series for one term from the screening store (every stored check, oldest first), optionally with the top apps at each check.",
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
        return json({ term, country: country.toUpperCase(), checks: rows.map((r) => (includeTopApps ? r : { ...r, topApps: undefined })) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "screen_store_status",
    {
      title: "Screening store status",
      description: "Location and counts of the server-owned screening store (rank checks, cached suggestion queries, running jobs).",
      inputSchema: {},
    },
    async () => {
      try {
        return json(await withScreenStore((s) => (reconcileRunning(s), { ...s.stats(), ...s.pendingSummary() })));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
