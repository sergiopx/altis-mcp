/** Tools that read the local Altis ASO store (altis_*). */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withStore, json, fail } from "../util.js";
import { MetricsCache } from "../metrics.js";
import type { Keyword } from "../db.js";

function attachMetrics(keywords: Keyword[]): Array<Keyword & { metrics: ReturnType<MetricsCache["forKeyword"]> | null }> {
  const cache = new MetricsCache();
  return keywords.map((k) => ({ ...k, metrics: k.text ? cache.forKeyword(k.text, k.countryCode ?? "US") : null }));
}

export function registerAltisTools(server: McpServer): void {
server.registerTool(
  "altis_status",
  {
    title: "Altis status",
    description:
      "Check the local Altis ASO database: path, whether the app is installed/running, and aggregate keyword stats.",
    inputSchema: {},
  },
  async () => {
    try {
      return withStore((s) => json({ storePath: s.path, wal: s.wal, metricsCaches: new MetricsCache().available(), apps: s.listApps().length, agents: s.listAgents().length, ...s.stats() }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "altis_list_apps",
  {
    title: "List tracked apps",
    description:
      "List apps tracked in Altis with their Apple ID and keyword counts. The pseudo-app 'Explore' (appleId 'explore-altis') holds keywords found by Explore agents that are not attached to a real app.",
    inputSchema: {},
  },
  async () => {
    try {
      return withStore((s) => json(s.listApps()));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "altis_app_summary",
  {
    title: "App summary",
    description: "Summary for one tracked app: metadata, ranking stats (top 10/50/100), low fruits, and breakdown by country.",
    inputSchema: { appId: z.number().int().describe("Altis app id from altis_list_apps") },
  },
  async ({ appId }) => {
    try {
      return withStore((s) => {
        const app = s.getApp(appId);
        if (!app) return fail(`No tracked app with id ${appId}`);
        return json({ app, stats: s.stats(appId) });
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "altis_list_keywords",
  {
    title: "List keywords",
    description:
      "Query keywords tracked or discovered in Altis. Each keyword carries popularity (0-100), difficulty (0-100), ASO/Ads opportunity scores, ads pollution, the app's last search position, and low-fruit flags. Filter and sort to answer questions like 'which keywords rank top 10' or 'best low-difficulty opportunities'. " +
      "includeMetrics: true merges Altis's analysis caches: intent (Discovery / Keyword Intent / Needs), opportunity (realOpportunityScore, difficultyScore, ...), advanced metrics, and top10 { maxReviews, sumReviews, avgRating, newestAgeDays, medianAgeDays, dominantGenre, apps }.",
    inputSchema: {
      appId: z.number().int().optional().describe("Restrict to one tracked app"),
      countryCode: z.string().length(2).optional().describe("ISO country code, e.g. US"),
      source: z.enum(["manual", "explorer", "suggestion"]).optional().describe("How the keyword was added"),
      search: z.string().optional().describe("Substring match on keyword text"),
      lowFruitOnly: z.boolean().optional(),
      veryLowFruitOnly: z.boolean().optional(),
      opportunityOnly: z.boolean().optional(),
      rankedOnly: z.boolean().optional().describe("Only keywords where the app currently ranks"),
      minPopularity: z.number().optional(),
      maxDifficulty: z.number().optional(),
      orderBy: z.enum(["popularity", "difficulty", "asoOpportunity", "adsOpportunity", "lastPosition", "lastUpdated", "text"]).optional(),
      orderDir: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(1000).optional().default(100),
      offset: z.number().int().min(0).optional().default(0),
      includeHistory: z.boolean().optional().default(false).describe("Include position history samples"),
      includeMetrics: z.boolean().optional().default(false).describe("Attach intent, opportunity and Top 10 metrics from Altis's caches"),
    },
  },
  async ({ includeHistory, includeMetrics, ...filter }) => {
    try {
      return withStore((s) => {
        const r = s.listKeywords(filter, includeHistory);
        return json(includeMetrics ? { total: r.total, keywords: attachMetrics(r.keywords) } : r);
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "altis_get_keyword",
  {
    title: "Get keyword",
    description: "Fetch one keyword with its full position history. Look up by Altis keyword id, or by text plus optional country/app. includeMetrics adds intent, opportunity and Top 10 metrics.",
    inputSchema: {
      id: z.number().int().optional(),
      text: z.string().optional(),
      countryCode: z.string().length(2).optional(),
      appId: z.number().int().optional(),
      includeMetrics: z.boolean().optional().default(false),
    },
  },
  async ({ id, text, countryCode, appId, includeMetrics }) => {
    try {
      return withStore((s) => {
        const wrap = (ks: Keyword[]) => (includeMetrics ? attachMetrics(ks) : ks);
        if (id !== undefined) {
          const k = s.getKeyword(id);
          return k ? json(wrap([k])[0]) : fail(`No keyword with id ${id}`);
        }
        if (!text) return fail("Provide either id or text");
        const ks = s.findKeyword(text, countryCode, appId);
        return ks.length ? json(wrap(ks)) : fail(`No keyword '${text}' found`);
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "altis_low_fruits",
  {
    title: "Low fruits",
    description:
      "Shortcut for the best opportunities Altis has found: keywords flagged low fruit or very low fruit (decent popularity, low difficulty), sorted by ASO opportunity.",
    inputSchema: {
      appId: z.number().int().optional(),
      countryCode: z.string().length(2).optional(),
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
  },
  async ({ appId, countryCode, limit }) => {
    try {
      return withStore((s) => {
        const low = s.listKeywords({ appId, countryCode, lowFruitOnly: true, orderBy: "asoOpportunity", limit });
        const veryLow = s.listKeywords({ appId, countryCode, veryLowFruitOnly: true, orderBy: "asoOpportunity", limit });
        return json({ lowFruits: low, veryLowFruits: veryLow });
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "altis_list_agents",
  {
    title: "List Explore agents",
    description:
      "List Altis Explore agents (background keyword discovery runs): seed keyword, countries, criteria, progress counters and status.",
    inputSchema: {},
  },
  async () => {
    try {
      return withStore((s) => json(s.listAgents()));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "altis_volume_estimates",
  {
    title: "Keyword volume estimates",
    description: "Altis AI demand-level estimates for keywords (level plus explanation), optionally filtered by keyword and country.",
    inputSchema: {
      keyword: z.string().optional(),
      countryCode: z.string().length(2).optional(),
    },
  },
  async ({ keyword, countryCode }) => {
    try {
      return withStore((s) => json(s.listVolumeEstimates(keyword, countryCode)));
    } catch (e) {
      return fail(e);
    }
  },
);

}
