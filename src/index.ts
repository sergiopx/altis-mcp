#!/usr/bin/env node
/**
 * altis-mcp: Model Context Protocol server for Altis ASO (https://tryaltis.com).
 *
 * Tool groups:
 *  - altis_*        read the local Altis app database (tracked apps, keywords,
 *                   positions, low-fruit discoveries, explorer agents, cached metrics),
 *                   plus guarded keyword writes through UI automation.
 *  - appstore_*     query Apple's public App Store endpoints live (search, lookup,
 *                   autocomplete, rank checks, paced batches) behind one rate limiter.
 *  - screen*        the screening pipeline and its persistent store.
 *  - metadata_check title / subtitle / keyword-field validation.
 *  - rate_status    throttle state of the Apple limiter.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { storePath } from "./db.js";
import { registerAltisTools } from "./tools/altis.js";
import { registerAppStoreTools } from "./tools/appstore.js";
import { registerAltisWriteTools } from "./tools/altis-write.js";
import { registerScreenTools } from "./tools/screen.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { screenStorePath } from "./screenstore.js";

const server = new McpServer({ name: "altis-mcp", version: "0.2.0" });

registerAltisTools(server);
registerAppStoreTools(server);
registerAltisWriteTools(server);
registerScreenTools(server);
registerMetadataTools(server);

// ---------------------------------------------------------------- resources

server.registerResource(
  "altis-store-info",
  "altis://store",
  { title: "Altis database location", description: "Path of the local Altis ASO SQLite store", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: storePath() }] }),
);

server.registerResource(
  "screen-store-info",
  "altis://screen-store",
  { title: "Screening store location", description: "Path of the server-owned screening SQLite store", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: screenStorePath() }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

