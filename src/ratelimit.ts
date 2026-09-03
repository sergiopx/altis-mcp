/**
 * Shared pacing and backoff for every Apple call the server makes.
 *
 * Apple throttles per client (~20 calls/min across storefronts) and answers
 * with HTTP 403 (sometimes 429). One process-wide limiter serialises calls,
 * enforces a minimum interval between them, honours Retry-After, and applies
 * exponential backoff (60 s, 120 s, ... capped) when Apple gives no hint.
 *
 * `now` and `sleep` are injectable so tests can drive the limiter without
 * wall-clock waits.
 */

export const DEFAULT_PACE_MS = 3000;
export const DEFAULT_INITIAL_BACKOFF_MS = 60_000;
export const DEFAULT_MAX_BACKOFF_MS = 600_000;

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

export interface RateLimiterOptions {
  /** Minimum interval between two Apple calls. Env ALTIS_MCP_PACE_MS overrides the default. */
  paceMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Per-call override of the minimum interval (e.g. a batch running with its own pacing). */
  paceMs?: number;
}

export interface RateStatus {
  callsLastMinute: Record<string, number>;
  totalCallsLastMinute: number;
  lastRateLimitAt: string | null;
  lastRateLimitStatus: number | null;
  consecutiveRateLimits: number;
  /** Length of the backoff window currently in force (0 when none). */
  currentBackoffSeconds: number;
  /** Backoff that would be applied by the next 403/429 without a Retry-After header. */
  nextBackoffSeconds: number;
  /** Seconds until the limiter would let the next call through (0 = now). */
  nextSafeCallInSeconds: number;
  paceMs: number;
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
  paceMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  private calls: Array<{ endpoint: string; at: number }> = [];
  private lastCallAt = -Infinity;
  private backoffUntil = -Infinity;
  private currentBackoffMs = 0;
  private consecutive = 0;
  private lastRateLimitAtMs: number | null = null;
  private lastRateLimitStatus: number | null = null;
  /** Serialises concurrent acquire() callers so pacing holds across tools. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions = {}) {
    this.paceMs = opts.paceMs ?? DEFAULT_PACE_MS;
    this.initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Earliest time (ms) the next call may start. */
  nextSafeAt(paceMs = this.paceMs): number {
    return Math.max(this.lastCallAt + paceMs, this.backoffUntil, 0);
  }

  /**
   * Wait until a call is allowed (pace interval and any active backoff), then
   * record it. Calls from concurrent callers are queued in order.
   */
  async acquire(endpoint: string, opts: AcquireOptions = {}): Promise<void> {
    const run = async () => {
      if (opts.signal?.aborted) throw abortError(opts.signal);
      const pace = opts.paceMs ?? this.paceMs;
      // Loop: a rate limit recorded by another caller while we slept extends the window.
      for (;;) {
        const wait = this.nextSafeAt(pace) - this.now();
        if (wait <= 0) break;
        await this.sleep(wait, opts.signal);
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

  /** A call completed with a non-throttled response: clear the backoff ladder. */
  recordSuccess(_endpoint: string): void {
    this.consecutive = 0;
    this.currentBackoffMs = 0;
    this.backoffUntil = -Infinity;
  }

  /**
   * A call was throttled. Returns the number of seconds to wait before the
   * next call, derived from Retry-After when present, else exponential backoff.
   */
  recordRateLimit(endpoint: string, status: number, retryAfterHeader?: string | null): number {
    const now = this.now();
    this.consecutive += 1;
    this.lastRateLimitAtMs = now;
    this.lastRateLimitStatus = status;
    const fromHeader = parseRetryAfter(retryAfterHeader, now);
    let waitMs: number;
    if (fromHeader !== null) {
      waitMs = fromHeader * 1000;
    } else {
      waitMs = Math.min(this.initialBackoffMs * 2 ** (this.consecutive - 1), this.maxBackoffMs);
    }
    this.currentBackoffMs = waitMs;
    this.backoffUntil = now + waitMs;
    void endpoint;
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
      currentBackoffSeconds: active ? Math.ceil(this.currentBackoffMs / 1000) : 0,
      nextBackoffSeconds: Math.ceil(nextBackoffMs / 1000),
      nextSafeCallInSeconds: Math.max(0, Math.ceil((this.nextSafeAt() - now) / 1000)),
      paceMs: this.paceMs,
    };
  }

  /** Forget all history (tests). */
  reset(): void {
    this.calls = [];
    this.lastCallAt = -Infinity;
    this.backoffUntil = -Infinity;
    this.currentBackoffMs = 0;
    this.consecutive = 0;
    this.lastRateLimitAtMs = null;
    this.lastRateLimitStatus = null;
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.calls.length && this.calls[0].at < cutoff) this.calls.shift();
  }
}

function paceFromEnv(): number {
  const raw = process.env.ALTIS_MCP_PACE_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PACE_MS;
}

/** The single limiter shared by every Apple-calling function in the process. */
export const appleLimiter = new AppleRateLimiter({ paceMs: paceFromEnv() });
