# ADR 0001: Share the Apple rate budget across processes through screen.sqlite

Date: 2026-09-03 · Status: accepted

## Context

Apple meters calls per client, and every altis-mcp process on the machine is the same client: the server spawned by a Claude Code session, the server spawned by a dev session, and every detached job worker. On 2026-09-03 two jobs in two processes each paced at their own interval and Apple saw the sum; the result was a 403 streak, an 8-minute backoff and 16 rank checks in 6 minutes. A per-process in-memory limiter cannot know about the others.

A probe on the same day measured the real limit: about 40 calls per minute holds indefinitely, 60 per minute trips a 403 under sustained load, and the lockout is about a minute. Spacing alone is not what Apple counts; the number of callers matters.

## Decision

Limiter state lives in a `limiters` table inside the screening store (`screen.sqlite`), one row per limiter name (`search`, `autocomplete`), holding `last_call_at`, `last_rate_limit_at`, `backoff_until`, `consecutive`, `multiplier`.

Every process keeps its in-memory limiter as the fast path and, when it is about to call, claims the slot in the store inside a `BEGIN IMMEDIATE` transaction: read the row, allow the call only if `now >= max(last_call_at + pace, backoff_until)`, and write `last_call_at = now` in the same transaction. SQLite's single writer makes two processes' claims serial, so both cannot pass inside one pace interval. Rate limits and the adaptive multiplier are written to the row so a 403 seen by one process slows the others at their next call. A stored multiplier older than one hour is ignored.

If the store cannot be opened or a write fails, the limiter continues on local state. Sharing is a safety net, never a dependency.

## Alternatives considered

- **A single daemon owning all Apple calls.** Correct by construction, but a new long-lived process to install, supervise and discover, for a tool installed with `npx`. Rejected for operational weight.
- **File locks (flock) around calls.** No place to keep backoff and multiplier, and lock semantics differ across filesystems. Rejected.
- **Only detached workers, never in-process calls.** Still several workers, so still several processes. Does not solve it.
- **Do nothing; lower the default pace far enough.** Two processes at 40 per minute each is 80 per minute. Any safe single-process pace is unsafe for two.

## Consequences

- One SQLite write per Apple call (about one per 1.5 s per limiter). Negligible against the network call, and the table is tiny.
- The screening store becomes required infrastructure for pacing, not only for results. It already existed and was already opened by every job.
- Tests for the limiter stay wall-clock free: the backend takes `now` from the caller, and an in-memory limiter without a backend behaves exactly as before.
- A stale `backoff_until` written by a crashed process expires on its own; a stale `last_call_at` only delays the next caller by at most one pace.
