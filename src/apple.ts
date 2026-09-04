/**
 * Apple public App Store endpoints (no auth): search, lookup, autocomplete
 * hints and rank checks built on top of them. Search/lookup requests go through
 * the search limiter and autocomplete through its own, so pacing and backoff
 * hold across all tools without one endpoint's 403 slowing the other.
 */
import { AppleRateLimitError, AppleRateLimiter, searchLimiter, suggestLimiter } from "./ratelimit.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export interface AppResult {
  trackId: number;
  bundleId: string;
  trackName: string;
  sellerName: string;
  primaryGenreName: string;
  averageUserRating?: number;
  userRatingCount?: number;
  price?: number;
  currency?: string;
  releaseDate?: string;
  currentVersionReleaseDate?: string;
  version?: string;
  trackViewUrl: string;
  artworkUrl100?: string;
  description?: string;
}

interface SearchResponse {
  resultCount: number;
  results: AppResult[];
}

export interface FetchOptions {
  signal?: AbortSignal;
  paceMs?: number;
}

/** Fetch through a limiter; 403/429 become AppleRateLimitError and arm that limiter's backoff. */
async function limitedFetch(limiter: AppleRateLimiter, endpoint: string, url: string, init: RequestInit, opts: FetchOptions = {}): Promise<Response> {
  await limiter.acquire(endpoint, { signal: opts.signal, paceMs: opts.paceMs });
  const res = await fetch(url, { ...init, signal: opts.signal });
  if (res.status === 403 || res.status === 429) {
    const wait = limiter.recordRateLimit(endpoint, res.status, res.headers.get("retry-after"));
    throw new AppleRateLimitError(endpoint, res.status, wait, url);
  }
  if (!res.ok) throw new Error(`Apple API ${res.status} for ${url}`);
  limiter.recordSuccess(endpoint);
  return res;
}

async function fetchJson<T>(endpoint: string, url: string, opts?: FetchOptions): Promise<T> {
  const res = await limitedFetch(searchLimiter, endpoint, url, { headers: { "User-Agent": UA, Accept: "application/json" } }, opts);
  return (await res.json()) as T;
}

function slim(a: AppResult, withDescription = false): AppResult {
  return {
    trackId: a.trackId,
    bundleId: a.bundleId,
    trackName: a.trackName,
    sellerName: a.sellerName,
    primaryGenreName: a.primaryGenreName,
    averageUserRating: a.averageUserRating !== undefined ? Math.round(a.averageUserRating * 100) / 100 : undefined,
    userRatingCount: a.userRatingCount,
    price: a.price,
    currency: a.currency,
    releaseDate: a.releaseDate,
    currentVersionReleaseDate: a.currentVersionReleaseDate,
    version: a.version,
    trackViewUrl: a.trackViewUrl,
    artworkUrl100: a.artworkUrl100,
    ...(withDescription ? { description: a.description } : {}),
  };
}

export async function searchApps(term: string, country = "us", limit = 25, opts?: FetchOptions): Promise<AppResult[]> {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", term);
  url.searchParams.set("media", "software");
  url.searchParams.set("entity", "software");
  url.searchParams.set("country", country.toLowerCase());
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 200)));
  const data = await fetchJson<SearchResponse>("search", url.toString(), opts);
  return data.results.map((a) => slim(a));
}

export async function lookupApp(id: string, country = "us", opts?: FetchOptions): Promise<AppResult | null> {
  const url = new URL("https://itunes.apple.com/lookup");
  if (/^\d+$/.test(id)) url.searchParams.set("id", id);
  else url.searchParams.set("bundleId", id);
  url.searchParams.set("country", country.toLowerCase());
  url.searchParams.set("entity", "software");
  const data = await fetchJson<SearchResponse>("lookup", url.toString(), opts);
  return data.results[0] ? slim(data.results[0], true) : null;
}

/** App Store search-bar autocomplete suggestions for a term. */
export async function searchHints(term: string, country = "us", opts?: FetchOptions): Promise<string[]> {
  const url = new URL("https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints");
  url.searchParams.set("clientApplication", "Software");
  url.searchParams.set("term", term);
  const storefront = STOREFRONTS[country.toUpperCase()] ?? STOREFRONTS.US;
  const res = await limitedFetch(
    suggestLimiter,
    "hints",
    url.toString(),
    { headers: { "User-Agent": UA, "X-Apple-Store-Front": `${storefront}-1,29` } },
    opts,
  );
  const xml = await res.text();
  // Response is an XML plist; hint terms are <key>term</key><string>...</string>.
  const out: string[] = [];
  for (const m of xml.matchAll(/<key>term<\/key>\s*<string>([^<]*)<\/string>/g)) {
    out.push(decodeXml(m[1]));
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ---------------------------------------------------------------- app-name detection

/** Lowercase, strip punctuation, collapse whitespace: "1RM Club: Rep Calc" -> "1rm club rep calc". */
export function normalizeTerm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const TITLE_SEPARATORS = [" - ", ": ", " | ", " – ", " — ", " · "];

function hasSeparator(s: string): boolean {
  return TITLE_SEPARATORS.some((sep) => s.includes(sep));
}

/**
 * Whether an autocomplete suggestion looks like an app title rather than a
 * query. True when it contains a title separator, or when (normalized) it
 * equals a known app title or is the head of a titled app ("barload plate
 * calculator" for "BarLoad Plate Calculator - Gym") AND it is not generic: a
 * generic phrase ("plate calculator") also appears as a word sequence inside
 * two or more other titles ("Barbell Plate Calculator", "Plate Calculator Pro").
 * The flag is advisory; the screen tool reports what it dropped.
 */
export function looksLikeAppName(suggestion: string, knownNames: Iterable<string>): boolean {
  if (hasSeparator(suggestion)) return true;
  const norm = normalizeTerm(suggestion);
  if (!norm) return false;
  const titles = new Set<string>();
  let exact = false;
  let titledHead = false;
  for (const name of knownNames) {
    const n = normalizeTerm(name);
    if (!n) continue;
    titles.add(n);
    if (n === norm) exact = true;
    else if (hasSeparator(name) && n.startsWith(norm + " ")) titledHead = true;
  }
  if (!exact && !titledHead) return false;
  const needle = ` ${norm} `;
  let containers = 0;
  for (const t of titles) if (t !== norm && ` ${t} `.includes(needle)) containers += 1;
  return containers < 2; // a phrase used inside several other titles is a generic query, not a title
}

// ---------------------------------------------------------------- rank checks

export interface TopApp {
  position: number;
  trackId: number;
  bundleId: string;
  trackName: string;
  primaryGenreName: string;
  userRatingCount?: number;
  averageUserRating?: number;
  releaseDate?: string;
  currentVersionReleaseDate?: string;
}

export interface Top10Summary {
  count: number;
  maxReviews: number | null;
  sumReviews: number | null;
  avgRating: number | null;
  newestAgeDays: number | null;
  medianAgeDays: number | null;
  dominantGenre: string | null;
}

export interface RankResult {
  term: string;
  country: string;
  appId: string;
  position: number | null;
  checkedTop: number;
  topApps: TopApp[];
  top10: Top10Summary;
  checkedAt: string;
}

function ageDays(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 86_400_000));
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Scoring inputs over the top apps: reviews, rating, ages (from releaseDate), dominant genre. */
export function summarizeTop10(
  apps: Array<{ userRatingCount?: number | null; averageUserRating?: number | null; releaseDate?: string | null; primaryGenreName?: string | null }>,
  now = Date.now(),
): Top10Summary {
  const reviews = apps.map((a) => a.userRatingCount).filter((n): n is number => typeof n === "number");
  const ratings = apps.map((a) => a.averageUserRating).filter((n): n is number => typeof n === "number");
  const ages = apps.map((a) => ageDays(a.releaseDate ?? undefined, now)).filter((n): n is number => n !== null);
  const genres = new Map<string, number>();
  for (const a of apps) if (a.primaryGenreName) genres.set(a.primaryGenreName, (genres.get(a.primaryGenreName) ?? 0) + 1);
  let dominantGenre: string | null = null;
  let best = 0;
  for (const [g, n] of genres) if (n > best) ([dominantGenre, best] = [g, n]);
  return {
    count: apps.length,
    maxReviews: reviews.length ? Math.max(...reviews) : null,
    sumReviews: reviews.length ? reviews.reduce((a, b) => a + b, 0) : null,
    avgRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null,
    newestAgeDays: ages.length ? Math.min(...ages) : null,
    medianAgeDays: median(ages),
    dominantGenre,
  };
}

/** Index of an app (numeric id or bundle id) in a result list, or -1. */
export function findApp(results: AppResult[], appId: string): number {
  const isNumeric = /^\d+$/.test(appId);
  return results.findIndex((a) => (isNumeric ? String(a.trackId) === appId : a.bundleId === appId));
}

/** Build a RankResult from an already-fetched SERP. */
export function rankFromResults(term: string, appId: string, country: string, results: AppResult[]): RankResult {
  const idx = findApp(results, appId);
  const topApps: TopApp[] = results.slice(0, 10).map((a, i) => ({
    position: i + 1,
    trackId: a.trackId,
    bundleId: a.bundleId,
    trackName: a.trackName,
    primaryGenreName: a.primaryGenreName,
    userRatingCount: a.userRatingCount,
    averageUserRating: a.averageUserRating,
    releaseDate: a.releaseDate,
    currentVersionReleaseDate: a.currentVersionReleaseDate,
  }));
  return {
    term,
    country: country.toUpperCase(),
    appId,
    position: idx >= 0 ? idx + 1 : null,
    checkedTop: results.length,
    topApps,
    top10: summarizeTop10(topApps),
    checkedAt: new Date().toISOString(),
  };
}

/** Position of an app (numeric id or bundle id) in search results for a term. */
export async function checkRank(term: string, appId: string, country = "us", depth = 200, opts?: FetchOptions): Promise<RankResult> {
  const results = await searchApps(term, country, depth, opts);
  return rankFromResults(term, appId, country, results);
}

export interface BatchItemResult extends Partial<RankResult> {
  term: string;
  country: string;
  appId: string;
  attempts: number;
  error?: string;
  rateLimited?: boolean;
}

export interface BatchOptions {
  countries?: string[];
  depth?: number;
  paceMs?: number;
  /** Attempts per term before recording an error (rate limits are retried after backoff). */
  maxRetries?: number;
  signal?: AbortSignal;
  /** Called as each term completes (success or final failure); use it to persist or report progress. */
  onResult?: (r: BatchItemResult, done: number, total: number) => void | Promise<void>;
  /** Skip a term×country before fetching (e.g. checked recently). Return a cached result to emit it instead. */
  skip?: (term: string, country: string) => BatchItemResult | null | undefined;
}

export interface BatchSummary {
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  rateLimitHits: number;
  durationMs: number;
  /** Set when the batch stopped early (sustained rate limiting); unprocessed terms are omitted. */
  aborted?: string;
}

/** Consecutive 403/429 responses (each waited out with backoff) before a batch gives up. */
export const MAX_CONSECUTIVE_RATE_LIMITS = 6;

export interface RetryState {
  /** Consecutive rate-limit responses seen by this caller (reset on success). */
  consecutiveRateLimits: number;
  rateLimitHits: number;
}

export interface CheckOneOptions {
  depth?: number;
  paceMs?: number;
  maxRetries?: number;
  /** Consecutive rate limits before giving up (default MAX_CONSECUTIVE_RATE_LIMITS; Infinity = wait forever, as jobs do). */
  maxConsecutiveRateLimits?: number;
  signal?: AbortSignal;
}

/**
 * One rank check with the batch retry policy: rate-limit responses wait out
 * the limiter's backoff and retry without counting against maxRetries; other
 * errors retry up to maxRetries. Returns `aborted: true` when the caller's
 * consecutive rate-limit streak reaches maxConsecutiveRateLimits (synchronous
 * batches only; background jobs pass Infinity and wait out every backoff).
 */
export async function checkOneWithRetry(
  term: string,
  appId: string,
  country: string,
  state: RetryState,
  opts: CheckOneOptions = {},
): Promise<{ item: BatchItemResult; aborted: boolean }> {
  const maxRetries = opts.maxRetries ?? 5;
  let attempts = 0;
  let lastError = "";
  let rateLimited = false;
  while (attempts < maxRetries) {
    attempts += 1;
    try {
      const r = await checkRank(term, appId, country, opts.depth ?? 200, { signal: opts.signal, paceMs: opts.paceMs });
      state.consecutiveRateLimits = 0;
      return { item: { ...r, attempts }, aborted: false };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastError = e instanceof Error ? e.message : String(e);
      if (e instanceof AppleRateLimitError) {
        state.rateLimitHits += 1;
        state.consecutiveRateLimits += 1;
        rateLimited = true;
        attempts -= 1; // the limiter has armed its backoff; the next acquire() waits it out
        if (state.consecutiveRateLimits >= (opts.maxConsecutiveRateLimits ?? MAX_CONSECUTIVE_RATE_LIMITS)) {
          return { item: { term, country: country.toUpperCase(), appId, attempts, error: lastError, rateLimited }, aborted: true };
        }
      }
    }
  }
  return { item: { term, country: country.toUpperCase(), appId, attempts, error: lastError || "unknown error", rateLimited }, aborted: false };
}

/**
 * Sequential paced rank checks over terms × countries. Rate-limit responses
 * wait out the limiter's backoff and retry; other errors retry up to maxRetries.
 */
export async function checkRankBatch(
  terms: string[],
  appId: string,
  opts: BatchOptions = {},
): Promise<{ results: BatchItemResult[]; summary: BatchSummary }> {
  const countries = (opts.countries?.length ? opts.countries : ["us"]).map((c) => c.toUpperCase());
  const started = Date.now();
  const results: BatchItemResult[] = [];
  const summary: BatchSummary = { total: terms.length * countries.length, ok: 0, failed: 0, skipped: 0, rateLimitHits: 0, durationMs: 0 };
  const state: RetryState = { consecutiveRateLimits: 0, rateLimitHits: 0 };
  let done = 0;

  outer: for (const country of countries) {
    for (const term of terms) {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Batch aborted");
      const cached = opts.skip?.(term, country);
      if (cached) {
        summary.skipped += 1;
        results.push(cached);
        done += 1;
        await opts.onResult?.(cached, done, summary.total);
        continue;
      }
      const { item, aborted } = await checkOneWithRetry(term, appId, country, state, opts);
      summary.rateLimitHits = state.rateLimitHits;
      if (item.error) summary.failed += 1;
      else summary.ok += 1;
      if (aborted) {
        // Roughly half an hour of straight 403s: stop the whole batch. Completed terms are already persisted.
        summary.aborted = `Stopped after ${state.consecutiveRateLimits} consecutive rate-limit responses; retry later (see rate_status)`;
      }
      results.push(item);
      done += 1;
      await opts.onResult?.(item, done, summary.total);
      if (summary.aborted) break outer;
    }
  }
  summary.durationMs = Date.now() - started;
  return { results, summary };
}

/** Storefront ids for the hints endpoint (X-Apple-Store-Front header). */
const STOREFRONTS: Record<string, number> = {
  US: 143441, GB: 143444, CA: 143455, AU: 143460, DE: 143443, FR: 143442, IT: 143450, ES: 143454,
  NL: 143452, SE: 143456, NO: 143457, DK: 143458, FI: 143447, CH: 143459, AT: 143445, BE: 143446,
  IE: 143449, PT: 143453, PL: 143478, JP: 143462, KR: 143466, CN: 143465, HK: 143463, TW: 143470,
  SG: 143464, IN: 143467, MX: 143468, BR: 143503, AR: 143505, CL: 143483, CO: 143501, RU: 143469,
  TR: 143480, SA: 143479, AE: 143481, ZA: 143472, NZ: 143461, ID: 143476, TH: 143475, MY: 143473,
  PH: 143474, VN: 143471, IL: 143491, EG: 143516, NG: 143561, PK: 143477, UA: 143492, CZ: 143489,
  HU: 143482, GR: 143448, RO: 143487,
};
