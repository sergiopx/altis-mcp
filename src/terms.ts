/**
 * Word-level matching for candidate filters. Every rule is whole-word and
 * case-insensitive: `plate` matches "pay by plate chicago" but not "template",
 * and the phrase `plate calc` matches "barbell plate calc" but not "plate math calc".
 */

/** Words too generic to identify a topic when includeAny defaults to the seed words. */
export const STOP_WORDS = new Set(["app", "apps", "for", "the", "and", "free", "best", "with", "your", "my"]);

export function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** True when `phrase`'s words appear contiguously, in order, inside `term`'s words. */
export function containsPhrase(term: string, phrase: string): boolean {
  const t = words(term);
  const p = words(phrase);
  if (!p.length || p.length > t.length) return false;
  outer: for (let i = 0; i + p.length <= t.length; i++) {
    for (let j = 0; j < p.length; j++) if (t[i + j] !== p[j]) continue outer;
    return true;
  }
  return false;
}

/** True when any of `phrases` is contained in `term` (whole-word). An empty list never matches. */
export function matchesAny(term: string, phrases: Iterable<string>): boolean {
  for (const p of phrases) if (containsPhrase(term, p)) return true;
  return false;
}

/** Default includeAny: every seed word of 3+ characters that is not a stop word. Numbers count ("531"). */
export function defaultIncludeAny(seeds: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const s of seeds) for (const w of words(s)) if (w.length >= 3 && !STOP_WORDS.has(w)) out.add(w);
  return [...out];
}
