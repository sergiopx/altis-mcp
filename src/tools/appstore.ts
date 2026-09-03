/** Tools that query Apple's public App Store endpoints live (appstore_*). */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, fail } from "../util.js";
import { checkRank, lookupApp, searchApps, searchHints } from "../apple.js";

export function registerAppStoreTools(server: McpServer): void {
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

}
