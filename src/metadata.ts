/**
 * App Store metadata checks: character limits, wasted duplicate words across
 * fields, keyword-field hygiene, and whole-word coverage of tracked keywords.
 *
 * Apple indexes the title, subtitle and keyword field as one bag of words and
 * matches multi-word queries by combining words across fields, so a tracked
 * keyword is "covered" when every one of its (non-stop) words appears as a
 * whole word somewhere in the three fields.
 */

export const LIMITS = { title: 30, subtitle: 30, keywords: 100 } as const;

/** Words Apple ignores in search; putting them in metadata wastes characters. */
export const STOP_WORDS = new Set([
  "a", "an", "and", "the", "of", "for", "to", "in", "on", "with", "your", "you", "my", "by", "at", "or", "is", "it", "its",
]);

export interface MetadataInput {
  title: string;
  subtitle: string;
  keywords: string;
  trackedKeywords?: string[];
}

export interface FieldReport {
  text: string;
  length: number;
  limit: number;
  ok: boolean;
  words: string[];
}

export interface CoverageReport {
  keyword: string;
  covered: boolean;
  missingWords: string[];
  ignoredStopWords: string[];
}

export interface MetadataReport {
  fields: { title: FieldReport; subtitle: FieldReport; keywords: FieldReport };
  duplicateWords: Array<{ word: string; fields: string[]; wastedChars: number }>;
  keywordField: {
    entries: string[];
    emptyEntries: number;
    entriesWithSpacesAroundCommas: string[];
    duplicateEntries: string[];
    multiWordEntries: string[];
    entriesRepeatingTitleOrSubtitle: string[];
  };
  stopWordsFound: Array<{ word: string; fields: string[] }>;
  coverage: CoverageReport[];
  summary: { ok: boolean; covered: number; notCovered: number; problems: string[] };
}

/** Lowercase whole words; punctuation (including & : , -) is a separator. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function field(text: string, limit: number): FieldReport {
  const length = [...text].length;
  return { text, length, limit, ok: length <= limit, words: tokenize(text) };
}

export function checkMetadata(input: MetadataInput): MetadataReport {
  const fields = {
    title: field(input.title, LIMITS.title),
    subtitle: field(input.subtitle, LIMITS.subtitle),
    keywords: field(input.keywords, LIMITS.keywords),
  };
  const problems: string[] = [];
  for (const [name, f] of Object.entries(fields)) {
    if (!f.ok) problems.push(`${name} is ${f.length} chars (limit ${f.limit})`);
  }

  // Keyword field hygiene.
  const rawEntries = input.keywords.split(",");
  const entries = rawEntries.map((e) => e.trim()).filter(Boolean);
  const emptyEntries = rawEntries.length - entries.length;
  const entriesWithSpacesAroundCommas = rawEntries.filter((e) => e !== e.trim() && e.trim()).map((e) => e.trim());
  const seen = new Set<string>();
  const duplicateEntries: string[] = [];
  for (const e of entries) {
    const k = e.toLowerCase();
    if (seen.has(k)) duplicateEntries.push(e);
    seen.add(k);
  }
  const multiWordEntries = entries.filter((e) => tokenize(e).length > 1);
  const titleSubWords = new Set([...fields.title.words, ...fields.subtitle.words]);
  const entriesRepeatingTitleOrSubtitle = entries.filter((e) => tokenize(e).every((w) => titleSubWords.has(w)));
  if (emptyEntries) problems.push(`${emptyEntries} empty keyword entr${emptyEntries === 1 ? "y" : "ies"}`);
  if (entriesWithSpacesAroundCommas.length) problems.push(`spaces around commas in keyword field waste ${input.keywords.length - input.keywords.replace(/\s*,\s*/g, ",").length} chars`);
  if (duplicateEntries.length) problems.push(`duplicate keyword entries: ${duplicateEntries.join(", ")}`);
  if (entriesRepeatingTitleOrSubtitle.length) problems.push(`keyword entries already in title/subtitle: ${entriesRepeatingTitleOrSubtitle.join(", ")}`);

  // Duplicate words across fields.
  const wordFields = new Map<string, Set<string>>();
  for (const [name, f] of Object.entries(fields)) {
    for (const w of f.words) {
      if (!wordFields.has(w)) wordFields.set(w, new Set());
      wordFields.get(w)!.add(name);
    }
  }
  const duplicateWords = [...wordFields.entries()]
    .filter(([, fs]) => fs.size > 1)
    .map(([word, fs]) => ({ word, fields: [...fs], wastedChars: word.length * (fs.size - 1) }));
  if (duplicateWords.length) problems.push(`words repeated across fields: ${duplicateWords.map((d) => d.word).join(", ")}`);

  const stopWordsFound = [...wordFields.entries()].filter(([w]) => STOP_WORDS.has(w)).map(([word, fs]) => ({ word, fields: [...fs] }));
  if (stopWordsFound.length) problems.push(`stop words Apple ignores: ${stopWordsFound.map((s) => s.word).join(", ")}`);

  // Coverage of tracked keywords by whole-word combination.
  const allWords = new Set(wordFields.keys());
  const coverage: CoverageReport[] = (input.trackedKeywords ?? []).map((kw) => {
    const words = tokenize(kw);
    const ignoredStopWords = words.filter((w) => STOP_WORDS.has(w));
    const missingWords = words.filter((w) => !STOP_WORDS.has(w) && !allWords.has(w));
    return { keyword: kw, covered: missingWords.length === 0, missingWords, ignoredStopWords };
  });
  const notCovered = coverage.filter((c) => !c.covered);
  if (notCovered.length) problems.push(`${notCovered.length} tracked keyword(s) not covered: ${notCovered.map((c) => c.keyword).join(", ")}`);

  return {
    fields,
    duplicateWords,
    keywordField: { entries, emptyEntries, entriesWithSpacesAroundCommas, duplicateEntries, multiWordEntries, entriesRepeatingTitleOrSubtitle },
    stopWordsFound,
    coverage,
    summary: {
      ok: Object.values(fields).every((f) => f.ok) && duplicateWords.length === 0 && emptyEntries === 0 && entriesWithSpacesAroundCommas.length === 0 && duplicateEntries.length === 0,
      covered: coverage.length - notCovered.length,
      notCovered: notCovered.length,
      problems,
    },
  };
}
