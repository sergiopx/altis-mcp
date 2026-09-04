# altis-mcp — domain glossary

The vocabulary of the keyword screening loop, as used in tool names, fields and this repo's docs. Implementation lives in `src/`; decisions in `docs/adr/`.

## Keywords and where they live

- **Tracked keyword**: a keyword present in the local Altis ASO store for an app. Altis tracks its position over time. The free plan freezes tracking beyond 30 keywords.
- **Candidate**: a search term the loop is considering for an app but that is not tracked in Altis. Candidates exist only in the server-owned screening store.
- **Seed**: a term supplied by the user to start expansion. A seed is always a candidate as well.
- **Expansion**: turning seeds into candidates through App Store autocomplete (seed plus letter suffixes) and seed × modifier combinations.
- **Candidate source**: how a candidate entered the pool. `seed` (given by the user), `autocomplete` (an Apple suggestion), or `combo` (seed × modifier).
- **App name**: an autocomplete suggestion that is an app's title rather than a query people type. Detected by matching against titles seen in search results; dropped from the pool.

## Filtering and selection

- **Exclude phrase**: a whole-word phrase the user does not want. A candidate containing it is dropped. "plate" excludes "pay by plate chicago" but not "template".
- **includeAny**: a list of whole words; a candidate must contain at least one of them. Defaults to the seed words of three or more characters, minus stop words. Seeds themselves are never subject to it.
- **Selection**: applying the candidate budget (`maxCandidates`) to the whole expanded pool after every seed is expanded. Order: seeds, then autocomplete candidates, then combos; within each class one candidate per seed in turn (round-robin).
- **Truncated candidate**: a candidate cut by selection. Stored, visible, never checked in that job.

## Checking

- **Rank check**: one App Store search for a term in one storefront to find the target app's position and the top apps' metrics (reviews, rating, release dates, genre).
- **Screen** (verb, tool `screen`): expand, select, then rank-check candidates for an app. **Expand-only screen**: stops after selection.
- **Batch** (tool `appstore_check_rank_batch`): rank checks for a given list of terms, no expansion.
- **Rescreen window** (`rescreenAfterDays`): a stored rank check younger than this is reused instead of asking Apple again. A reused check is a **skipped** candidate.
- **Shortlist**: candidates whose latest check meets the scoring rules (app ranks in the top 100, or the top 10 is weak).

## Jobs

- **Job**: one screen or batch run, identified by a job id, with progress persisted in the screening store so any server process can report it.
- **Phase**: `expanding`, `selecting`, `checking`, `finished`.
- **Candidate status** inside a job: `candidate` (selected, no check requested), `truncated`, `pending` (awaiting a check), `skipped`, `done`, `error`, `cancelled`.
- **Owner**: the process running a job. `this-process`, `other-process` (a detached worker or another server), or `none` for finished jobs.
- **Dead job**: a job the store marks running whose worker process is gone or whose heartbeat is stale. Reported as `aborted`; its pending candidates are released.

## Apple pacing

- **Limiter**: the per-endpoint gate every Apple call passes through. Two exist: search (search, lookup, rank checks, SERPs) and autocomplete.
- **Pace**: the minimum start-to-start interval between two calls on one limiter.
- **Floor**: the configured pace (default or environment override). A job's or call's own pace can only raise the interval above the floor, never lower it.
- **Adaptive multiplier**: a factor applied to the floor after each rate limit (×1.5 per 403, up to ×4) for the rest of the process.
- **Effective pace**: floor × adaptive multiplier, or the caller's requested pace if longer. What is actually enforced.
- **Rate limit**: Apple answering 403 or 429. Measured on 2026-09-03: about 40 calls per minute is sustained safely, 60 per minute is not; a lockout lasts about a minute.
- **Backoff**: the wait imposed after a rate limit. Retry-After when Apple sends it, else 60 s doubling per consecutive rate limit, capped at 300 s. The ladder resets after ten clean calls.
- **Shared budget**: the limiter state kept in the screening store so every altis-mcp process on the machine paces against one clock.
