/**
 * Live App Store data. These are the same public Apple endpoints Altis itself
 * uses (itunes.apple.com/search, /lookup and the MZSearchHints suggestions feed).
 */

const UA = "altis-mcp/0.1 (+https://tryaltis.com)";

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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Apple API ${res.status} for ${url}`);
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

export async function searchApps(term: string, country = "us", limit = 25): Promise<AppResult[]> {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", term);
  url.searchParams.set("media", "software");
  url.searchParams.set("entity", "software");
  url.searchParams.set("country", country.toLowerCase());
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 200)));
  const data = await fetchJson<SearchResponse>(url.toString());
  return data.results.map((a) => slim(a));
}

export async function lookupApp(id: string, country = "us"): Promise<AppResult | null> {
  const url = new URL("https://itunes.apple.com/lookup");
  if (/^\d+$/.test(id)) url.searchParams.set("id", id);
  else url.searchParams.set("bundleId", id);
  url.searchParams.set("country", country.toLowerCase());
  url.searchParams.set("entity", "software");
  const data = await fetchJson<SearchResponse>(url.toString());
  return data.results[0] ? slim(data.results[0], true) : null;
}

/** App Store search-bar autocomplete suggestions for a term. */
export async function searchHints(term: string, country = "us"): Promise<string[]> {
  const url = new URL("https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints");
  url.searchParams.set("clientApplication", "Software");
  url.searchParams.set("term", term);
  const storefront = STOREFRONTS[country.toUpperCase()] ?? STOREFRONTS.US;
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": UA, "X-Apple-Store-Front": `${storefront}-1,29` },
  });
  if (!res.ok) throw new Error(`Apple hints API ${res.status}`);
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

export interface RankResult {
  term: string;
  country: string;
  appId: string;
  position: number | null;
  checkedTop: number;
  topApps: Array<{ position: number; trackId: number; trackName: string; userRatingCount?: number; averageUserRating?: number }>;
}

/** Position of an app (numeric id or bundle id) in search results for a term. */
export async function checkRank(term: string, appId: string, country = "us", depth = 200): Promise<RankResult> {
  const results = await searchApps(term, country, depth);
  const isNumeric = /^\d+$/.test(appId);
  const idx = results.findIndex((a) => (isNumeric ? String(a.trackId) === appId : a.bundleId === appId));
  return {
    term,
    country: country.toUpperCase(),
    appId,
    position: idx >= 0 ? idx + 1 : null,
    checkedTop: results.length,
    topApps: results.slice(0, 10).map((a, i) => ({
      position: i + 1,
      trackId: a.trackId,
      trackName: a.trackName,
      userRatingCount: a.userRatingCount,
      averageUserRating: a.averageUserRating,
    })),
  };
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
