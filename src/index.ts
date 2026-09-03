#!/usr/bin/env node
/**
 * altis-mcp: Model Context Protocol server for Altis ASO (https://tryaltis.com).
 *
 * Tools fall in two groups:
 *  - altis_*  read the local Altis app database (tracked apps, keywords,
 *             positions, low-fruit discoveries, explorer agents).
 *  - appstore_* query Apple's public App Store endpoints live (search,
 *             lookup, autocomplete suggestions, rank checks).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AltisStore, storePath } from "./db.js";
import { checkRank, lookupApp, searchApps, searchHints } from "./apple.js";

const server = new McpServer({ name: "altis-mcp", version: "0.1.0" });

/** Open the store lazily per call so the server still starts if Altis is absent. */
function withStore<T>(fn: (s: AltisStore) => T): T {
  const store = new AltisStore();
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

// ---------------------------------------------------------------- local data

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
      return withStore((s) => json({ storePath: s.path, apps: s.listApps().length, agents: s.listAgents().length, ...s.stats() }));
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
      "Query keywords tracked or discovered in Altis. Each keyword carries popularity (0-100), difficulty (0-100), ASO/Ads opportunity scores, ads pollution, the app's last search position, and low-fruit flags. Filter and sort to answer questions like 'which keywords rank top 10' or 'best low-difficulty opportunities'.",
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
    },
  },
  async ({ includeHistory, ...filter }) => {
    try {
      return withStore((s) => json(s.listKeywords(filter, includeHistory)));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "altis_get_keyword",
  {
    title: "Get keyword",
    description: "Fetch one keyword with its full position history. Look up by Altis keyword id, or by text plus optional country/app.",
    inputSchema: {
      id: z.number().int().optional(),
      text: z.string().optional(),
      countryCode: z.string().length(2).optional(),
      appId: z.number().int().optional(),
    },
  },
  async ({ id, text, countryCode, appId }) => {
    try {
      return withStore((s) => {
        if (id !== undefined) {
          const k = s.getKeyword(id);
          return k ? json(k) : fail(`No keyword with id ${id}`);
        }
        if (!text) return fail("Provide either id or text");
        const ks = s.findKeyword(text, countryCode, appId);
        return ks.length ? json(ks) : fail(`No keyword '${text}' found`);
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

// ---------------------------------------------------------------- live App Store

server.registerTool(
  "appstore_search",
  {
    title: "App Store search",
    description: "Search the App Store for a keyword and return the ranked apps (the SERP), with ratings and review counts.",
    inputSchema: {
      term: z.string(),
      country: z.string().length(2).optional().default("us"),
      limit: z.number().int().min(1).max(200).optional().default(25),
    },
  },
  async ({ term, country, limit }) => {
    try {
      const results = await searchApps(term, country, limit);
      return json({ term, country: country.toUpperCase(), resultCount: results.length, results: results.map((a, i) => ({ position: i + 1, ...a })) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "appstore_lookup",
  {
    title: "App Store lookup",
    description: "Fetch an app's App Store listing by numeric Apple ID or bundle identifier, including its description.",
    inputSchema: {
      id: z.string().describe("Numeric Apple ID (e.g. 6768525538) or bundle id"),
      country: z.string().length(2).optional().default("us"),
    },
  },
  async ({ id, country }) => {
    try {
      const app = await lookupApp(id, country);
      return app ? json(app) : fail(`No app found for ${id} in ${country}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "appstore_suggestions",
  {
    title: "App Store search suggestions",
    description: "App Store search-bar autocomplete suggestions for a seed term. Useful for discovering keyword variations users actually type.",
    inputSchema: {
      term: z.string(),
      country: z.string().length(2).optional().default("us"),
    },
  },
  async ({ term, country }) => {
    try {
      return json({ term, country: country.toUpperCase(), suggestions: await searchHints(term, country) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "appstore_check_rank",
  {
    title: "Check keyword rank",
    description: "Live check of where an app ranks in App Store search results for a term (searches the top N results). Returns the position and the top 10 competitors.",
    inputSchema: {
      term: z.string(),
      appId: z.string().describe("Numeric Apple ID or bundle id of the app to find"),
      country: z.string().length(2).optional().default("us"),
      depth: z.number().int().min(10).max(200).optional().default(200),
    },
  },
  async ({ term, appId, country, depth }) => {
    try {
      return json(await checkRank(term, appId, country, depth));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------- resources

server.registerResource(
  "altis-store-info",
  "altis://store",
  { title: "Altis database location", description: "Path of the local Altis ASO SQLite store", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: storePath() }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
