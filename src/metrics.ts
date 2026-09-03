/**
 * Altis keeps per-keyword analysis in JSON caches beside its store:
 *   AltisASO/advanced_metrics_cache.json   "<keyword>:<COUNTRY>" -> ratings, reviews, ages, velocity
 *   AltisASO/competitor_cache.json         "<keyword>:<COUNTRY>" -> { apps: top 10 with reviews, rating, releaseDate }
 *   AltisASO/opportunity_cache.json        "<keyword>:<COUNTRY>" -> { result: { realOpportunityScore, difficultyScore, ... } }
 *   AltisASO/keyword_intention_cache.json  "<keyword>"           -> { intention: Discovery | Keyword Intent | Needs }
 * This module merges them so a keyword row carries the Top 10 inputs the
 * scoring rules use. Files are read lazily, once per instance, and missing
 * files simply yield nulls.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storePath } from "./db.js";
import { summarizeTop10, type Top10Summary } from "./apple.js";

export function metricsDir(): string {
  return process.env.ALTIS_METRICS_DIR ?? join(dirname(storePath()), "AltisASO");
}

export interface CompetitorApp {
  position: number | null;
  trackId: number | null;
  bundleId: string | null;
  name: string | null;
  reviews: number | null;
  rating: number | null;
  releaseDate: string | null;
  genre: string | null;
}

export interface KeywordMetrics {
  intent: string | null;
  opportunity: {
    realOpportunityScore: number | null;
    difficultyScore: number | null;
    popularityScore: number | null;
    asoOpportunity: number | null;
    adsOpportunity: number | null;
    adsPollution: number | null;
    advertisersCount: number | null;
    organicPower: number | null;
    cachedDate: string | null;
  } | null;
  advanced: {
    averageRating: number | null;
    averageReviews: number | null;
    lowestRating: number | null;
    mostRecentReviews: number | null;
    mostRecentRating: number | null;
    mostRecentAppAge: number | null;
    averageAppAge: number | null;
    mostRecentLastUpdate: number | null;
    averageLastUpdate: number | null;
    categoryRankPotential: string | null;
    reviewsVelocity: unknown;
    cachedDate: string | null;
  } | null;
  top10: (Top10Summary & { apps: CompetitorApp[]; cachedDate: string | null }) | null;
}

type Dict = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function mapCompetitorApp(a: Dict): CompetitorApp {
  return {
    position: num(a.position),
    trackId: num(a.trackId ?? a.id),
    bundleId: str(a.bundleId),
    name: str(a.trackName ?? a.name),
    reviews: num(a.userRatingCount),
    rating: num(a.averageUserRating),
    releaseDate: str(a.releaseDate),
    genre: str(a.primaryGenreName),
  };
}

/** Build the Top 10 summary from a competitor_cache entry. */
export function top10FromCompetitors(entry: Dict | null | undefined, now = Date.now()): KeywordMetrics["top10"] {
  const raw = entry?.apps;
  if (!Array.isArray(raw)) return null;
  const apps = (raw as Dict[]).map(mapCompetitorApp).sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  const summary = summarizeTop10(
    apps.map((a) => ({ userRatingCount: a.reviews, averageUserRating: a.rating, releaseDate: a.releaseDate, primaryGenreName: a.genre })),
    now,
  );
  return { ...summary, apps, cachedDate: str(entry?.cachedDate) };
}

export class MetricsCache {
  readonly dir: string;
  private files = new Map<string, Dict | null>();

  constructor(dir = metricsDir()) {
    this.dir = dir;
  }

  private load(name: string): Dict | null {
    if (this.files.has(name)) return this.files.get(name)!;
    const p = join(this.dir, name);
    let data: Dict | null = null;
    if (existsSync(p)) {
      try {
        data = JSON.parse(readFileSync(p, "utf8")) as Dict;
      } catch {
        data = null;
      }
    }
    this.files.set(name, data);
    return data;
  }

  available(): Record<string, boolean> {
    const names = ["advanced_metrics_cache.json", "competitor_cache.json", "opportunity_cache.json", "keyword_intention_cache.json"];
    return Object.fromEntries(names.map((n) => [n, existsSync(join(this.dir, n))]));
  }

  private entry(file: string, key: string): Dict | null {
    const data = this.load(file);
    if (!data) return null;
    const v = data[key] ?? data[key.toLowerCase()];
    return v && typeof v === "object" ? (v as Dict) : null;
  }

  forKeyword(text: string, country: string, now = Date.now()): KeywordMetrics {
    const key = `${text}:${country.toUpperCase()}`;
    const intent = this.entry("keyword_intention_cache.json", text) ?? this.entry("keyword_intention_cache.json", text.toLowerCase());
    const opp = this.entry("opportunity_cache.json", key);
    const oppResult = (opp?.result as Dict | undefined) ?? null;
    const adv = this.entry("advanced_metrics_cache.json", key);
    const comp = this.entry("competitor_cache.json", key);
    return {
      intent: str(intent?.intention),
      opportunity: oppResult
        ? {
            realOpportunityScore: num(oppResult.realOpportunityScore),
            difficultyScore: num(oppResult.difficultyScore),
            popularityScore: num(oppResult.popularityScore),
            asoOpportunity: num(oppResult.asoOpportunity),
            adsOpportunity: num(oppResult.adsOpportunity),
            adsPollution: num(oppResult.adsPollution),
            advertisersCount: num(oppResult.advertisersCount),
            organicPower: num(oppResult.organicPower),
            cachedDate: str(opp?.cachedDate),
          }
        : null,
      advanced:
        adv && Object.keys(adv).length > 1
          ? {
              averageRating: num(adv.averageRating),
              averageReviews: num(adv.averageReviews),
              lowestRating: num(adv.lowestRating),
              mostRecentReviews: num(adv.mostRecentReviews),
              mostRecentRating: num(adv.mostRecentRating),
              mostRecentAppAge: num(adv.mostRecentAppAge),
              averageAppAge: num(adv.averageAppAge),
              mostRecentLastUpdate: num(adv.mostRecentLastUpdate),
              averageLastUpdate: num(adv.averageLastUpdate),
              categoryRankPotential: str(adv.categoryRankPotential),
              reviewsVelocity: adv.reviewsVelocity ?? null,
              cachedDate: str(adv.cachedDate),
            }
          : null,
      top10: top10FromCompetitors(comp, now),
    };
  }
}
