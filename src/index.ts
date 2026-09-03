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
import { storePath } from "./db.js";
import { registerAltisTools } from "./tools/altis.js";
import { registerAppStoreTools } from "./tools/appstore.js";

const server = new McpServer({ name: "altis-mcp", version: "0.1.0" });

registerAltisTools(server);
registerAppStoreTools(server);

// ---------------------------------------------------------------- resources

server.registerResource(
  "altis-store-info",
  "altis://store",
  { title: "Altis database location", description: "Path of the local Altis ASO SQLite store", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: storePath() }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
