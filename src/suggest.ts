/** Autocomplete with the on-disk cache and app-name flagging. */
import { looksLikeAppName, searchApps, searchHints } from "./apple.js";
import { DEFAULT_SUGGESTION_TTL_MS, type ScreenStore } from "./screenstore.js";

export interface SuggestionOptions {
  refresh?: boolean;
  /** Attach isAppName to each suggestion (default true). */
  detectAppNames?: boolean;
  /** Allow one search call for the term's SERP to learn app titles (default true). Skipped when the suggestions came from cache and titles are already known. */
  serpLookup?: boolean;
  ttlMs?: number;
  signal?: AbortSignal;
  /** Pace override for the autocomplete limiter. */
  paceMs?: number;
  /** Pace override for the search limiter (SERP lookup). */
  serpPaceMs?: number;
  /** Extra app titles to match against (e.g. learned from an earlier query of the same seed). */
  extraNames?: Iterable<string>;
}

/**
 * App titles come from SERPs stored in the screening store, `extraNames`, and
 * (when allowed) one search call for this term. Returns the titles used so
 * callers can reuse them for sibling queries.
 */
export async function suggestionsWithFlags(store: ScreenStore, term: string, country: string, opts: SuggestionOptions = {}) {
  const ttl = opts.ttlMs ?? DEFAULT_SUGGESTION_TTL_MS;
  const cached = opts.refresh ? null : store.getSuggestions(term, country, ttl);
  let raw: string[];
  let fromCache = false;
  let fetchedAt: string;
  if (cached) {
    raw = cached.suggestions;
    fromCache = true;
    fetchedAt = cached.fetchedAt;
  } else {
    raw = await searchHints(term, country, { signal: opts.signal, paceMs: opts.paceMs });
    store.saveSuggestions(term, country, raw);
    fetchedAt = new Date().toISOString();
  }
  const names: string[] = [];
  let serpCalls = 0;
  if (opts.detectAppNames !== false) {
    names.push(...store.knownAppNames(country), ...(opts.extraNames ?? []));
    if (opts.serpLookup !== false && (!fromCache || names.length === 0)) {
      const serp = await searchApps(term, country, 50, { signal: opts.signal, paceMs: opts.serpPaceMs });
      serpCalls = 1;
      names.push(...serp.map((a) => a.trackName));
    }
  }
  const suggestions = raw.map((s) => ({ term: s, isAppName: opts.detectAppNames === false ? undefined : looksLikeAppName(s, names) }));
  return { term, country: country.toUpperCase(), fromCache, fetchedAt, serpCalls, suggestions, namesUsed: names };
}
