# altis-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Altis ASO](https://tryaltis.com), the macOS App Store Optimization app.

Altis has no public API. This server reads the app's local SwiftData store
(from a WAL-consistent snapshot, safe while Altis is running) and, for live
data, calls the same public Apple endpoints Altis uses behind one rate limiter.
Keyword adds and deletes go through macOS UI automation with guards; the SQLite
store is never written.

## Requirements

- macOS with Altis ASO installed and opened at least once
- Node.js 22.13+ (uses the built-in `node:sqlite`, no native builds)

## Install

No install step needed; run it with `npx`.

### Claude Code

```sh
claude mcp add altis -s user -- npx -y altis-mcp
```

### Claude Desktop / other clients

```json
{
  "mcpServers": {
    "altis": { "command": "npx", "args": ["-y", "altis-mcp"] }
  }
}
```

### From source

```sh
git clone https://github.com/sergiopx/altis-mcp && cd altis-mcp
pnpm install && pnpm build
claude mcp add altis -s user -- node "$PWD/dist/index.js"
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ALTIS_STORE_PATH` | Altis container `default.store` | Altis SQLite store to read |
| `ALTIS_METRICS_DIR` | `AltisASO/` beside the store | Altis JSON caches (metrics, competitors, intent, opportunity) |
| `ALTIS_MCP_DATA_DIR` | `~/Library/Application Support/altis-mcp` | Server-owned screening store and autocomplete cache |
| `ALTIS_MCP_PACE_SEARCH_MS` | `1200` | Minimum spacing between search/lookup calls (rank checks, SERPs) |
| `ALTIS_MCP_PACE_SUGGEST_MS` | `600` | Minimum spacing between autocomplete calls |

## Tools

Local Altis data:

| Tool | What it does |
|---|---|
| `altis_status` | Store path plus aggregate stats (ranked, top 10/50/100, low fruits, by country) |
| `altis_list_apps` | Tracked apps with Apple ID and keyword counts |
| `altis_app_summary` | One app's metadata and ranking stats |
| `altis_list_keywords` | Filter/sort keywords by app, country, source, popularity, difficulty, rank, low-fruit flags; `includeMetrics` merges intent, opportunity and Top 10 metrics from Altis's caches |
| `altis_get_keyword` | One keyword with full position history (and `includeMetrics`) |
| `altis_low_fruits` | Keywords Altis flagged as low / very low fruit, best ASO opportunity first |
| `altis_list_agents` | Explore agents: seed, countries, criteria, progress |
| `altis_volume_estimates` | AI demand-level estimates per keyword |

Altis writes (UI automation; Altis must be running and frontmost):

| Tool | What it does |
|---|---|
| `altis_add_keywords` | Type keywords into the Add field and verify the store count. Guards: dedupe, 30-slot free-plan limit, no open dialog |
| `altis_delete_keywords` | Delete one keyword at a time via the "Delete Selected" button, verifying the count drops by exactly 1 each time |

Live App Store (Apple public endpoints; search and autocomplete each have their own limiter with backoff on 403/429):

| Tool | What it does |
|---|---|
| `appstore_search` | Search results (SERP) for a term; `targetAppId` adds the target's position in the same call |
| `appstore_lookup` | App listing by Apple ID or bundle id |
| `appstore_suggestions` | Autocomplete suggestions, cached 7 days on disk, each flagged `isAppName` when it looks like an app title |
| `appstore_check_rank` | Where an app ranks for a term right now, the top 10 with release dates and genre, and a `top10` summary |
| `appstore_check_rank_batch` | Paced rank checks for many terms and countries; every result persisted as it completes; `async: true` returns a job id |
| `rate_status` | Per-endpoint calls per minute, last 403/429, current backoff, seconds until the next safe call |

Screening pipeline (server-owned SQLite store):

| Tool | What it does |
|---|---|
| `screen` | Background job: seeds → cached autocomplete expansion (letter suffixes, modifiers) → dedupe → drop app titles, tracked and excluded terms → rank checks that start as soon as candidates exist. Returns a job id (`async: false` blocks) |
| `screen_job_status` | Phase, seeds expanded, candidates found, checks done/total, rate limits, backoff, ETA, last 10 checks. Works across server processes and restarts |
| `screen_job_cancel` | Stop a job after its current Apple call |
| `screen_jobs` | Recent jobs with status and progress |
| `screen_results` | Latest stored check per term with scoring inputs: position, maxReviews, sumReviews, avgRating, newestAgeDays, medianAgeDays, dominantGenre; plus pending-term counts of running jobs |
| `screen_history` | Position series for one term |
| `screen_store_status` | Store location and counts |

Metadata:

| Tool | What it does |
|---|---|
| `metadata_check` | Title/subtitle/keyword-field limits (30/30/100), duplicated words, keyword-field hygiene, stop words, whole-word coverage of tracked keywords |

## How the data is stored

Altis writes to
`~/Library/Containers/com.bfat.dev.AltisASO/Data/Library/Application Support/default.store`,
a Core Data SQLite file in WAL mode with four entities: `TrackedApp`, `Keyword`,
`ExplorerAgent`, `KeywordVolumeEstimate`. Timestamps are seconds since
2001-01-01 and are converted to ISO 8601. Position history is a JSON blob.
Recent commits live in `default.store-wal` until Altis checkpoints, so the
server copies the main file plus `-wal` and `-shm` to a temp dir and opens the
copy; `altis_status.wal` reports the snapshot.

Altis's keyword analysis (Top 10 competitors, intent, opportunity, advanced
metrics) lives in JSON caches under `AltisASO/` beside the store, keyed by
`"<keyword>:<COUNTRY>"`. `includeMetrics` merges them.

The server's own data (rank checks, suggestion cache, jobs) lives in
`~/Library/Application Support/altis-mcp/screen.sqlite`. Jobs run inside the
server process and keep running after the client that started them
disconnects; their state is written to the store on every step, so any later
client (or a restarted server) can read status and results. A job whose
heartbeat stops for 15 minutes is reported as aborted.

## Development

```sh
pnpm dev            # run from source (Node type stripping)
pnpm test           # build and run unit tests (no network)
node scripts/smoke.mjs   # exercise every tool over stdio (a few Apple calls)
pnpm inspect        # MCP Inspector UI
```
