/**
 * Shared pacing and backoff for every Apple call the server makes.
 *
 * Apple throttles per client and answers with HTTP 403 (sometimes 429). The
 * search endpoint (itunes.apple.com/search, also used for lookups) and the
 * autocomplete endpoint (search hints) are throttled independently, so each
 * gets its own limiter: it serialises calls, enforces a minimum interval,
 * honours Retry-After, and applies exponential backoff (60 s, 120 s, 300 s cap)
 * when Apple gives no hint. A 403 on one endpoint never slows the other.
 *
 * What Apple actually meters is calls per minute, not spacing (measured
 * 2026-09-03: 40/min never tripped, 60/min did under sustained load, lockout
 * ~60 s). So:
 *   - the configured pace is a floor: a per-call `paceMs` can only raise the
 *     interval, never lower it, so concurrent jobs cannot halve the spacing;
 *   - after a 403 the pace is raised by 50 % (compounding, capped at 4x) for
 *     the rest of the process: the adaptive multiplier;
 *   - the backoff ladder resets only after SUCCESSES_TO_RESET clean calls.
 *
 * A `LimiterBackend` (see limiterstore.ts) lets several server processes share
 * one budget: the next call slot is claimed atomically in the store, and rate
 * limits seen by one process slow the others. In-memory state stays the fast
 * path; the backend is consulted once per call.
 *
 * `now` and `sleep` are injectable so tests can drive the limiter without
 * wall-clock waits.
 */

export const DEFAULT_PACE_MS = 3000;
/** 40 calls/min: measured 2026-09-03 (60/min 403s under sustained load, 40/min never did). */
export const DEFAULT_SEARCH_PACE_MS = 1500;
export const DEFAULT_SUGGEST_PACE_MS = 600;
export const DEFAULT_INITIAL_BACKOFF_MS = 60_000;
export const DEFAULT_MAX_BACKOFF_MS = 300_000;
/** Pace multiplier applied per 403/429, compounding up to ADAPTIVE_MAX. */
export const ADAPTIVE_STEP = 1.5;
export const ADAPTIVE_MAX = 4;
/** Clean calls needed before the backoff ladder (consecutive count) resets. */
export const SUCCESSES_TO_RESET = 10;
/** A multiplier read from the shared store is ignored when its last rate limit is older than this. */
export const SHARED_MULTIPLIER_TTL_MS = 3_600_000;

export class AppleRateLimitError extends Error {
  readonly rateLimited = true as const;
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly retryAfterSeconds: number,
    readonly url?: string,
  ) {
    super(`Apple API ${status} (rate limited) on ${endpoint}; retry after ${retryAfterSeconds}s`);
    this.name = "AppleRateLimitError";
  }
}

/** Limiter state shared between processes through a LimiterBackend. Times are epoch ms. */
export interface SharedLimiterState {
  lastCallAt: number;
  lastRateLimitAt: number | null;
  backoffUntil: number;
  consecutive: number;
  multiplier: number;
}

export type ClaimResult = { ok: true; state: SharedLimiterState } | { ok: false; nextSafeAt: number; state: SharedLimiterState };

export interface LimiterBackend {
  /**
   * Atomically claim the next call slot for `name`: succeeds (and records the
   * call at `now`) when now >= max(lastCallAt + paceMs, backoffUntil), else
   * says when to retry. Always returns the shared state so the caller can absorb it.
   */
  claim(name: string, paceMs: number, now: number): ClaimResult;
  update(name: string, patch: Partial<SharedLimiterState>): void;
}

export interface RateLimiterOptions {
  /** Key under which the backend stores this limiter's state. */
  name?: string;
  /** Minimum interval between two Apple calls. Env ALTIS_MCP_PACE_MS overrides the default. */
  paceMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Per-call interval request (e.g. a job running with its own pacing). It can only raise the effective pace. */
  paceMs?: number;
}

export interface RateStatus {
  callsLastMinute: Record<string, number>;
  totalCallsLastMinute: number;
  lastRateLimitAt: string | null;
  lastRateLimitStatus: number | null;
  consecutiveRateLimits: number;
  /** Clean calls since the last rate limit; the ladder resets at SUCCESSES_TO_RESET. */
  successesSinceRateLimit: number;
  /** Length of the backoff window currently in force (0 when none). */
  currentBackoffSeconds: number;
  /** Backoff that would be applied by the next 403/429 without a Retry-After header. */
  nextBackoffSeconds: number;
  /** Seconds until the limiter would let the next call through (0 = now). */
  nextSafeCallInSeconds: number;
  /** Configured floor (default or env override). */
  paceMs: number;
  /** Pace actually enforced right now: paceMs × adaptiveMultiplier. */
  effectivePaceMs: number;
  adaptiveMultiplier: number;
  /** True when the state is shared with other server processes through screen.sqlite. */
  shared: boolean;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into whole seconds. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.ceil(Number(s)));
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const e = new Error(typeof reason === "string" ? reason : "Aborted");
  e.name = "AbortError";
  return e;
}

export class AppleRateLimiter {
  readonly name: string;
  paceMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private backend: LimiterBackend | null = null;

  private calls: Array<{ endpoint: string; at: number }> = [];
  private lastCallAt = -Infinity;
  private backoffUntil = -Infinity;
  private currentBackoffMs = 0;
  private consecutive = 0;
  private successes = 0;
  private multiplier = 1;
  private lastRateLimitAtMs: number | null = null;
  private lastRateLimitStatus: number | null = null;
  /** Serialises concurrent acquire() callers so pacing holds across tools. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions = {}) {
    this.name = opts.name ?? "apple";
    this.paceMs = opts.paceMs ?? DEFAULT_PACE_MS;
    this.initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Share state with other processes. Pass null to detach. */
  attach(backend: LimiterBackend | null): void {
    this.backend = backend;
  }

  get isShared(): boolean {
    return this.backend !== null;
  }

  get adaptiveMultiplier(): number {
    return this.multiplier;
  }

  /** Interval enforced for a call: the floor (paceMs × multiplier) or the caller's request, whichever is longer. */
  effectivePace(requestedMs?: number): number {
    return Math.max(this.paceMs * this.multiplier, requestedMs ?? 0);
  }

  /** Earliest time (ms) the next call may start. */
  nextSafeAt(paceMs = this.effectivePace()): number {
    return Math.max(this.lastCallAt + paceMs, this.backoffUntil, 0);
  }

  /**
   * Wait until a call is allowed (pace interval and any active backoff), then
   * record it. Calls from concurrent callers are queued in order. With a
   * backend attached, the slot is also claimed in the shared store.
   */
  async acquire(endpoint: string, opts: AcquireOptions = {}): Promise<void> {
    const run = async () => {
      if (opts.signal?.aborted) throw abortError(opts.signal);
      for (;;) {
        // Multiplier may change while we sleep (a 403 elsewhere), so recompute each pass.
        const pace = this.effectivePace(opts.paceMs);
        const wait = this.nextSafeAt(pace) - this.now();
        if (wait > 0) {
          await this.sleep(wait, opts.signal);
          continue;
        }
        const claim = this.claimShared(pace);
        if (claim && !claim.ok) {
          await this.sleep(Math.max(1, claim.nextSafeAt - this.now()), opts.signal);
          continue;
        }
        break;
      }
      const at = this.now();
      this.lastCallAt = at;
      this.calls.push({ endpoint, at });
      this.prune(at);
    };
    const p = this.chain.then(run, run);
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /** Claim the slot in the shared store and absorb what other processes recorded. Backend failures fall back to local state. */
  private claimShared(pace: number): ClaimResult | null {
    if (!this.backend) return null;
    try {
      const r = this.backend.claim(this.name, pace, this.now());
      this.absorb(r.state);
      return r;
    } catch {
      return null;
    }
  }

  private absorb(s: SharedLimiterState): void {
    const now = this.now();
    if (s.backoffUntil > this.backoffUntil) {
      this.backoffUntil = s.backoffUntil;
      this.currentBackoffMs = Math.max(this.currentBackoffMs, s.backoffUntil - now);
    }
    if (s.lastRateLimitAt !== null && (this.lastRateLimitAtMs === null || s.lastRateLimitAt > this.lastRateLimitAtMs)) {
      this.lastRateLimitAtMs = s.lastRateLimitAt;
      this.successes = 0;
    }
    if (s.consecutive > this.consecutive) this.consecutive = s.consecutive;
    const fresh = s.lastRateLimitAt !== null && now - s.lastRateLimitAt < SHARED_MULTIPLIER_TTL_MS;
    if (fresh && s.multiplier > this.multiplier) this.multiplier = Math.min(s.multiplier, ADAPTIVE_MAX);
  }

  private share(patch: Partial<SharedLimiterState>): void {
    if (!this.backend) return;
    try {
      this.backend.update(this.name, patch);
    } catch {
      // shared store unavailable: local state still protects this process
    }
  }

  /** A call completed with a non-throttled response. The ladder resets after SUCCESSES_TO_RESET of these. */
  recordSuccess(_endpoint: string): void {
    this.successes += 1;
    if (this.consecutive > 0 && this.successes >= SUCCESSES_TO_RESET) {
      this.consecutive = 0;
      this.currentBackoffMs = 0;
      this.backoffUntil = -Infinity;
      this.share({ consecutive: 0, backoffUntil: 0 });
    }
  }

  /**
   * A call was throttled. Returns the number of seconds to wait before the
   * next call, derived from Retry-After when present, else exponential backoff.
   * Also raises the adaptive multiplier for the rest of the process.
   */
  recordRateLimit(_endpoint: string, status: number, retryAfterHeader?: string | null): number {
    const now = this.now();
    this.consecutive += 1;
    this.successes = 0;
    this.lastRateLimitAtMs = now;
    this.lastRateLimitStatus = status;
    this.multiplier = Math.min(this.multiplier * ADAPTIVE_STEP, ADAPTIVE_MAX);
    const fromHeader = parseRetryAfter(retryAfterHeader, now);
    const waitMs = fromHeader !== null ? fromHeader * 1000 : Math.min(this.initialBackoffMs * 2 ** (this.consecutive - 1), this.maxBackoffMs);
    this.currentBackoffMs = waitMs;
    this.backoffUntil = now + waitMs;
    this.share({ lastRateLimitAt: now, backoffUntil: this.backoffUntil, consecutive: this.consecutive, multiplier: this.multiplier });
    return Math.ceil(waitMs / 1000);
  }

  status(): RateStatus {
    const now = this.now();
    this.prune(now);
    const callsLastMinute: Record<string, number> = {};
    for (const c of this.calls) callsLastMinute[c.endpoint] = (callsLastMinute[c.endpoint] ?? 0) + 1;
    const active = this.backoffUntil > now;
    const nextBackoffMs = Math.min(this.initialBackoffMs * 2 ** this.consecutive, this.maxBackoffMs);
    return {
      callsLastMinute,
      totalCallsLastMinute: this.calls.length,
      lastRateLimitAt: this.lastRateLimitAtMs === null ? null : new Date(this.lastRateLimitAtMs).toISOString(),
      lastRateLimitStatus: this.lastRateLimitStatus,
      consecutiveRateLimits: this.consecutive,
      successesSinceRateLimit: this.successes,
      currentBackoffSeconds: active ? Math.ceil(this.currentBackoffMs / 1000) : 0,
      nextBackoffSeconds: Math.ceil(nextBackoffMs / 1000),
      nextSafeCallInSeconds: Math.max(0, Math.ceil((this.nextSafeAt() - now) / 1000)),
      paceMs: this.paceMs,
      effectivePaceMs: Math.round(this.effectivePace()),
      adaptiveMultiplier: +this.multiplier.toFixed(3),
      shared: this.backend !== null,
    };
  }

  /** Forget all history (tests). Keeps the backend attached. */
  reset(): void {
    this.calls = [];
    this.lastCallAt = -Infinity;
    this.backoffUntil = -Infinity;
    this.currentBackoffMs = 0;
    this.consecutive = 0;
    this.successes = 0;
    this.multiplier = 1;
    this.lastRateLimitAtMs = null;
    this.lastRateLimitStatus = null;
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.calls.length && this.calls[0].at < cutoff) this.calls.shift();
  }
}

function paceFromEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/** Limiter for itunes.apple.com/search and /lookup (rank checks, SERPs). Env: ALTIS_MCP_PACE_SEARCH_MS (or legacy ALTIS_MCP_PACE_MS). */
export const searchLimiter = new AppleRateLimiter({ name: "search", paceMs: paceFromEnv(["ALTIS_MCP_PACE_SEARCH_MS", "ALTIS_MCP_PACE_MS"], DEFAULT_SEARCH_PACE_MS) });

/** Limiter for the autocomplete (search hints) endpoint. Env: ALTIS_MCP_PACE_SUGGEST_MS. */
export const suggestLimiter = new AppleRateLimiter({ name: "autocomplete", paceMs: paceFromEnv(["ALTIS_MCP_PACE_SUGGEST_MS"], DEFAULT_SUGGEST_PACE_MS) });

/** Status of both limiters, as reported by rate_status. */
export function rateStatus() {
  return { search: searchLimiter.status(), autocomplete: suggestLimiter.status() };
}
