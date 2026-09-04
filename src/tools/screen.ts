/** Screening pipeline tools: screen, screen_job_status, screen_job_cancel, screen_jobs, screen_results, screen_history, screen_store_status. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, fail, failApple, withStore } from "../util.js";
import { rateStatus } from "../ratelimit.js";
import { withScreenStore } from "../screenstore.js";
import { DEFAULT_SUFFIXES, cancelJob, jobStatus, listJobs, reconcileRunning, startDetachedJob, startJob, type ScreenJobInput } from "../jobs.js";

export function registerScreenTools(server: McpServer): void {
  server.registerTool(
    "screen",
    {
      title: "Screen keyword candidates",
      description:
        "End-to-end keyword screening as a background job: seeds are expanded through cached autocomplete (letter suffixes, optional seed×modifier combos), normalized, deduped, " +
        "stripped of app titles and of terms tracked in Altis or listed in exclude, and rank-checked as soon as they appear (expansion and rank checks run concurrently on separate limiters). " +
        "Every rank check and autocomplete response is persisted immediately. Default async: true returns { jobId } at once; poll screen_job_status, read screen_results({ appId }) any time, " +
        "screen_job_cancel to stop. async: false blocks and returns the shortlist (small runs only). Candidates checked within rescreenAfterDays are reused without an Apple call.",
      inputSchema: {
        seeds: z.array(z.string().min(1)).min(1).max(2000),
        appId: z.string().describe("Numeric Apple ID or bundle id of the app to rank"),
        country: z.string().length(2).optional().default("us"),
        countries: z.array(z.string().length(2)).optional().describe("Several storefronts; overrides country"),
        suffixes: z.array(z.string()).optional().describe(`Autocomplete suffixes appended to each seed (default ${JSON.stringify(DEFAULT_SUFFIXES)})`),
        modifiers: z.array(z.string()).optional().describe("Generate seed × modifier combos (e.g. ['app','tracker'])"),
        exclude: z.array(z.string()).optional().describe("Terms to drop (case-insensitive)"),
        excludeTracked: z.boolean().optional().default(true).describe("Drop keywords already tracked in the local Altis store"),
        altisAppId: z.number().int().optional().describe("Restrict the tracked-keyword exclusion to one Altis app id"),
        maxCandidates: z.number().int().min(1).max(20000).optional().default(1000),
        rescreenAfterDays: z.number().min(0).optional().default(7).describe("Reuse stored rank checks newer than this"),
        depth: z.number().int().min(10).max(200).optional().default(200),
        searchPaceMs: z.number().int().min(0).max(60_000).optional().describe("Spacing between search calls for this job (default 1500)"),
        suggestPaceMs: z.number().int().min(0).max(60_000).optional().describe("Spacing between autocomplete calls for this job (default 600)"),
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
        const jobInput: ScreenJobInput = {
          kind: "screen",
          seeds: input.seeds,
          appId: input.appId,
          countries,
          suffixes: input.suffixes ?? DEFAULT_SUFFIXES,
          modifiers: input.modifiers ?? [],
          exclude: input.exclude ?? [],
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
            note: "Runs in a detached worker process. Poll screen_job_status({ jobId }); results accumulate in screen_results({ appId }) while it runs.",
          });
        }
        const job = startJob(jobInput);
        await job.done;
        const st = job.snapshot();
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
          ...(input.expandOnly ? { candidates: [...new Set(job.results.map((r) => r.term))] } : { shortlist: { ranked, weakTop10 } }),
          errors: job.results.filter((r) => r.error).map((r) => ({ term: r.term, country: r.country, error: r.error })),
          note: "Full rows: screen_results({ appId }). History per term: screen_history.",
        });
      } catch (e) {
        return failApple(e);
      }
    },
  );

  server.registerTool(
    "screen_job_status",
    {
      title: "Screening job status",
      description:
        "Progress of a screen or batch job: phase (expanding / checking / finished), seedsExpanded/seedsTotal, candidatesFound, checksDone/checksTotal, rateLimits, backoffSeconds, etaSeconds, " +
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
      description: "Stop a running screen or batch job after its current Apple call. Completed checks stay in the store. Works across server processes.",
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
