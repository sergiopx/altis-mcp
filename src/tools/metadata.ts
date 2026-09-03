/** metadata_check: App Store title / subtitle / keyword-field validation. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, fail } from "../util.js";
import { checkMetadata, LIMITS, STOP_WORDS } from "../metadata.js";

export function registerMetadataTools(server: McpServer): void {
  server.registerTool(
    "metadata_check",
    {
      title: "Check App Store metadata",
      description:
        `Validate a metadata draft: character counts vs limits (title ${LIMITS.title}, subtitle ${LIMITS.subtitle}, keyword field ${LIMITS.keywords}), words duplicated across fields (wasted characters), ` +
        "keyword-field hygiene (spaces around commas, empty or duplicate entries, entries already in the title/subtitle), stop words Apple ignores, and for each tracked keyword whether it is covered " +
        "by whole-word combination across the three fields, with the missing words. No network calls.",
      inputSchema: {
        title: z.string(),
        subtitle: z.string(),
        keywords: z.string().describe("Comma-separated keyword field"),
        trackedKeywords: z.array(z.string()).optional().describe("Keywords to check coverage for (e.g. from altis_list_keywords)"),
      },
    },
    async (input) => {
      try {
        return json({ ...checkMetadata(input), stopWordList: [...STOP_WORDS] });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
