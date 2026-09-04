# PRD: altis-mcp update for the LoadPR keyword screening loop

Date: 2026-09-03 · Owner: Sergio · Consumer: Claude Code driving the ASO loop for LoadPR (Apple ID 6768525538)

## 1. Background

altis-mcp exposes Altis ASO's local store (read-only) plus Apple's public search, lookup, and autocomplete
endpoints. On 2026-09-03 it was used to run five keyword rounds for LoadPR. The read side worked: live
positions matched Altis exactly (plate calculator #165 on both). Two things limited the loop:

1. **Throughput.** Screening 1,000+ candidates means 1,000+ Apple calls. Apple returns HTTP 403 after roughly
   20 calls per minute. The client had to spawn the server per batch, pace calls at 3.2 s, and keep its own
   resumable JSONL, all in a Python wrapper (`screen.py`, `mcp_call.py` in `~/xcode/loadpr-aso`).
2. **The write gap.** Altis has no API and no CSV import/export. Adds and deletes were done with System Events
   UI automation. Adds are reliable (the text field is exposed). Deletes needed coordinate clicks because the
   "Delete Selected" button and its confirmation dialog are invisible to Accessibility, and they broke twice:
   once when a dialog was left open, once when a browser window stole focus.

The scoring rules the loop applies (so the server returns the right inputs):

- Keep if LoadPR ranks in the top 100; or difficulty < 40 and the query is relevant; or the top 10 is weak:
  average rating < 4.0, max reviews < 50K, or **median app age < 6 months**.
- Drop if not ranking and difficulty > 50; or top 10 max reviews > 250K; or ambiguous single words.

## 2. Goals

- The 1,000-keyword screen runs as MCP calls only, no wrapper, resumable, throttle-aware.
- Each rank check carries every field the scoring rules need (positions, reviews, ratings, release dates).
- Altis keyword writes are available as tools with guards that make the failure modes seen today impossible.
- Local Altis reads reflect the last few minutes, not the last checkpoint.

Non-goals: Premium features (Explore, multi-country tracking in Altis), any write to Altis's SQLite store.

## 3. Requirements, by priority

### P0

| # | Subject | Why |
|---|---|---|
| 1 | `appstore_check_rank_batch` with built-in pacing and backoff | Removes the Python wrapper; 1,000 checks become one call. Retry on 403/429 with backoff, honor Retry-After, stream results. |
| 2 | Release dates in `appstore_check_rank` top apps | The "median app age < 6 months" rule needs `releaseDate` per top-10 app; today it costs a second `appstore_search` call. |
| 3 | Target position inside `appstore_search` | `appstore_search` with `limit: 200` plus `targetAppId` returns the SERP and the position in one payload. |
| 6 | Read the WAL | Copying `default.store` alone missed writes from the last minutes; the server must copy all three files or checkpoint first. Bug. |

### P1

| # | Subject | Why |
|---|---|---|
| 4 | `altis_add_keywords` / `altis_delete_keywords` with guards | Closes the write gap. Guards: refuse when a modal is open or Altis is not frontmost; 30-slot guard that counts frozen keywords from the store; verify before/after counts in the store; case-insensitive dedupe. |
| 5 | Top 10 metrics in `altis_list_keywords` | `advanced_metrics_cache.json`, `competitor_cache.json`, `keyword_intention_cache.json`, `opportunity_cache.json` sit beside the store; merging them replaces `altis_export.py`. |
| 8 | Persistent screening store + `screen_results` | Every rank check and autocomplete response stored by term, country, date. Enables resume, scoring queries, and day-7/day-14 comparisons for keywords never tracked in Altis. |
| 11 | `screen` pipeline tool | Seeds → autocomplete expansion with letter suffixes → dedupe → exclude tracked/previously tested → paced batch rank. This is `screen.py` server-side. |

### P2

| # | Subject | Why |
|---|---|---|
| 7 | Autocomplete cache on disk | Same prefixes hit across seeds; responses rarely change. |
| 9 | `isAppName` flag on autocomplete suggestions | Apple mixes app titles into suggestions; the server can match against search-result `trackName`s. Was the noisiest part of the candidate pool. |
| 10 | `metadata_check` tool | Character limits (30/30/100), cross-field duplicate words, whole-word coverage of tracked keywords. Two draft strings were wrong on first pass when done by hand. |
| 12 | `countries` list on batch tools | Prepares the MX/FR/GB pass. |
| 13 | `rate_status` tool | Expose throttle state; the 403 arrived with no warning. |

## 4. Acceptance criteria (summary; details in each GitHub issue)

- A 1,000-term batch completes without a client-side sleep and with zero unrecovered 403s.
- One rank check result contains position, and for each top-10 app: name, id, reviews, rating, releaseDate,
  currentVersionReleaseDate, primaryGenreName.
- `altis_status.keywords` matches the count shown in Altis within seconds of an add/delete.
- `altis_delete_keywords(["x"])` on a 31-keyword tracker removes exactly one keyword and returns before/after counts.
- `metadata_check` on the 2026-09-03 draft reports 30/30/99 chars and lists uncovered tracked keywords
  ("bench press calculator", "lift percentage calculator").

## 5. Sequencing

1 → 2 → 3 → 6 (P0) · then 4 and 5 in parallel · then 8 and 11 · then P2.

## 6. References

- Loop working files: `~/xcode/loadpr-aso/` (`LOG.md`, `screen.py`, `altis_ui.sh`, `sync_altis.py`, `METADATA_DRAFT.md`)
- Altis store: `~/Library/Containers/com.bfat.dev.AltisASO/Data/Library/Application Support/default.store` + `AltisASO/*.json`
- Delete geometry: "Delete Selected" is 73 px from the window's right edge and 22 px above its bottom;
  the free-plan banner (shown when > 30 keywords) pushes it up 90 px. The confirmation dialog is centered in
  the window; its confirm button is 81 px below the window's vertical center.

## 7. GitHub issues (numbers match the item numbers above)

| # | Issue |
|---|---|
| 1 | https://github.com/sergiopx/altis-mcp/issues/1 · appstore_check_rank_batch with pacing and backoff (P0) |
| 2 | https://github.com/sergiopx/altis-mcp/issues/2 · release dates and genre in appstore_check_rank (P0) |
| 3 | https://github.com/sergiopx/altis-mcp/issues/3 · target position inside appstore_search (P0) |
| 4 | https://github.com/sergiopx/altis-mcp/issues/4 · altis_add_keywords / altis_delete_keywords with guards (P1) |
| 5 | https://github.com/sergiopx/altis-mcp/issues/5 · Top 10 metrics, intent, opportunity in altis_list_keywords (P1) |
| 6 | https://github.com/sergiopx/altis-mcp/issues/6 · read the WAL (P0, bug) |
| 7 | https://github.com/sergiopx/altis-mcp/issues/7 · autocomplete cache on disk (P2) |
| 8 | https://github.com/sergiopx/altis-mcp/issues/8 · persistent screening store + screen_results (P1) |
| 9 | https://github.com/sergiopx/altis-mcp/issues/9 · isAppName flag on suggestions (P2) |
| 10 | https://github.com/sergiopx/altis-mcp/issues/10 · metadata_check tool (P2) |
| 11 | https://github.com/sergiopx/altis-mcp/issues/11 · screen pipeline tool (P1) |
| 12 | https://github.com/sergiopx/altis-mcp/issues/12 · countries list on batch tools (P2) |
| 13 | https://github.com/sergiopx/altis-mcp/issues/13 · rate_status and Retry-After (P2) |
