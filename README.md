# altis-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Altis ASO](https://tryaltis.com), the macOS App Store Optimization app.

Altis has no public API. This server reads the app's local SwiftData store
directly (read-only, safe while Altis is running) and, for live data, calls the
same public Apple endpoints Altis uses. Nothing is written to Altis.

## Requirements

- macOS with Altis ASO installed and opened at least once
- Node.js 22.13+ (uses the built-in `node:sqlite`, no native builds)

## Install

```sh
pnpm install
pnpm build
```

### Claude Code

```sh
claude mcp add altis -s user -- node /Users/sp/code/altis-mcp/dist/index.js
```

### Claude Desktop / other clients

```json
{
  "mcpServers": {
    "altis": { "command": "node", "args": ["/Users/sp/code/altis-mcp/dist/index.js"] }
  }
}
```

Set `ALTIS_STORE_PATH` to point at a different `default.store` if needed.

## Tools

Local Altis data:

| Tool | What it does |
|---|---|
| `altis_status` | Store path plus aggregate stats (ranked, top 10/50/100, low fruits, by country) |
| `altis_list_apps` | Tracked apps with Apple ID and keyword counts |
| `altis_app_summary` | One app's metadata and ranking stats |
| `altis_list_keywords` | Filter/sort keywords by app, country, source, popularity, difficulty, rank, low-fruit flags |
| `altis_get_keyword` | One keyword with full position history |
| `altis_low_fruits` | Keywords Altis flagged as low / very low fruit, best ASO opportunity first |
| `altis_list_agents` | Explore agents: seed, countries, criteria, progress |
| `altis_volume_estimates` | AI demand-level estimates per keyword |

Live App Store (Apple public endpoints):

| Tool | What it does |
|---|---|
| `appstore_search` | Search results (SERP) for a term with ratings and review counts |
| `appstore_lookup` | App listing by Apple ID or bundle id |
| `appstore_suggestions` | Search-bar autocomplete suggestions for a seed term |
| `appstore_check_rank` | Where an app ranks for a term right now, plus the top 10 |

## How the data is stored

Altis writes to
`~/Library/Containers/com.bfat.dev.AltisASO/Data/Library/Application Support/default.store`,
a Core Data SQLite file in WAL mode with four entities: `TrackedApp`, `Keyword`,
`ExplorerAgent`, `KeywordVolumeEstimate`. Timestamps are seconds since
2001-01-01 and are converted to ISO 8601. Position history is a JSON blob.

## Development

```sh
pnpm dev            # run from source (Node type stripping)
node scripts/smoke.mjs   # exercise every tool over stdio
pnpm inspect        # MCP Inspector UI
```
