/**
 * Read-only access to the Altis ASO local database.
 *
 * Altis stores everything in a SwiftData (Core Data) SQLite file inside its
 * sandbox container, in WAL mode. Recent commits live in `default.store-wal`
 * until Altis checkpoints, so reading the main file alone lags by minutes. We
 * copy the main file plus its -wal and -shm siblings to a private temp dir and
 * open the copy, which lets SQLite replay the WAL without ever touching (or
 * locking) the live files. The copy is deleted on close().
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

export const DEFAULT_STORE_PATH = join(
  homedir(),
  "Library/Containers/com.bfat.dev.AltisASO/Data/Library/Application Support/default.store",
);

export function storePath(): string {
  return process.env.ALTIS_STORE_PATH ?? DEFAULT_STORE_PATH;
}

/** Core Data stores dates as seconds since 2001-01-01T00:00:00Z. */
const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1);

export function coreDataDate(value: unknown): string | null {
  if (typeof value !== "number") return null;
  return new Date(CORE_DATA_EPOCH_MS + value * 1000).toISOString();
}

function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Blobs are either JSON (UTF-8) or an NSKeyedArchiver binary plist. */
function decodeBlob(value: unknown): unknown {
  if (!(value instanceof Uint8Array) || value.length === 0) return null;
  const buf = Buffer.from(value);
  if (buf.subarray(0, 6).toString("latin1") === "bplist") {
    return bplistStrings(buf);
  }
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return { _format: "unknown", base64: buf.toString("base64") };
  }
}

const ARCHIVER_TOKENS = new Set(["$null", "$class", "$classname", "$classes", "$archiver", "$top", "$objects", "$version", "root", "NS.objects", "NS.keys", "NSKeyedArchiver"]);

/**
 * Extract the string values from an NSKeyedArchiver binary plist, skipping the
 * archiver's own bookkeeping keys and class names. Enough to read an archived
 * [String] or Set<String> without a full plist implementation.
 */
function bplistStrings(buf: Buffer): string[] {
  const out: string[] = [];
  try {
    const trailer = buf.subarray(buf.length - 32);
    const offsetSize = trailer[6];
    const numObjects = Number(trailer.readBigUInt64BE(8));
    const tableOffset = Number(trailer.readBigUInt64BE(24));
    const readUInt = (pos: number, size: number) => {
      let v = 0;
      for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
      return v;
    };
    // Reads an object header; returns [marker low nibble or extended length, data start].
    const readLen = (pos: number): [number, number] => {
      const low = buf[pos] & 0x0f;
      if (low !== 0x0f) return [low, pos + 1];
      const intSize = 1 << (buf[pos + 1] & 0x0f);
      return [readUInt(pos + 2, intSize), pos + 2 + intSize];
    };
    for (let i = 0; i < numObjects; i++) {
      const pos = readUInt(tableOffset + i * offsetSize, offsetSize);
      const type = buf[pos] >> 4;
      if (type === 0x5) {
        const [len, start] = readLen(pos);
        out.push(buf.subarray(start, start + len).toString("latin1"));
      } else if (type === 0x6) {
        const [len, start] = readLen(pos);
        out.push(buf.subarray(start, start + len * 2).swap16().toString("utf16le"));
      }
    }
  } catch {
    return [];
  }
  return out.filter((s) => !ARCHIVER_TOKENS.has(s) && !/^NS[A-Z]/.test(s));
}

export interface TrackedApp {
  id: number;
  name: string | null;
  appleId: string | null;
  isExploreContainer: boolean;
  isFictional: boolean;
  autoSuggestionsEnabled: boolean;
  iconUrl: string | null;
  createdAt: string | null;
  keywordCount: number;
  bannedKeywords: unknown;
  savedSuggestions: unknown;
}

export interface PositionSample {
  position: number;
  date: string | null;
}

export interface Keyword {
  id: number;
  text: string | null;
  countryCode: string | null;
  source: string | null;
  appId: number | null;
  appName: string | null;
  explorerAgentId: number | null;
  agentName: string | null;
  popularity: number | null;
  difficulty: number | null;
  asoOpportunity: number | null;
  adsOpportunity: number | null;
  adsPollution: number | null;
  lastPosition: number | null;
  isLowFruit: boolean;
  isVeryLowFruit: boolean;
  isOpportunity: boolean;
  disqualificationReason: string | null;
  createdAt: string | null;
  lastUpdated: string | null;
  popularityDifficultyLastUpdated: string | null;
  positionHistory?: PositionSample[];
}

export interface ExplorerAgent {
  id: number;
  name: string | null;
  seedKeyword: string | null;
  mainSearchCountryCode: string | null;
  selectedCountries: unknown;
  allowedIntentions: unknown;
  isActive: boolean;
  isPaused: boolean;
  appId: number | null;
  keywordsAnalyzed: number | null;
  keywordsFound: number | null;
  lowFruitsFound: number | null;
  veryLowFruitsFound: number | null;
  opportunitiesFound: number | null;
  asoLowFruitsFound: number | null;
  asoVeryLowFruitsFound: number | null;
  adsLowFruitsFound: number | null;
  adsVeryLowFruitsFound: number | null;
  plannedVariationsCount: number | null;
  pendingAsaCount: number | null;
  criteria: {
    minPopularity: number | null;
    maxDifficulty: number | null;
    minAsoOpportunity: number | null;
    minAdsOpportunity: number | null;
    minVeryLowPopularity: number | null;
    maxVeryLowDifficulty: number | null;
    minVeryLowAsoOpportunity: number | null;
    minVeryLowAdsOpportunity: number | null;
    maxAverageRating: number | null;
    maxAverageReviews: number | null;
    maxAverageAppAge: number | null;
    minRatioPopularityOverDifficulty: number | null;
    minDemandLevel: string | null;
    requireAllCriteria: boolean;
  };
  createdAt: string | null;
  lastRunAt: string | null;
  firstKeywordAnalyzedAt: string | null;
  lastPauseTime: string | null;
  totalActiveTimeSeconds: number | null;
}

export interface VolumeEstimate {
  id: number;
  keyword: string | null;
  countryCode: string | null;
  level: string | null;
  explanation: string | null;
  updatedAt: string | null;
}

export interface KeywordFilter {
  appId?: number;
  countryCode?: string;
  source?: string;
  search?: string;
  lowFruitOnly?: boolean;
  veryLowFruitOnly?: boolean;
  opportunityOnly?: boolean;
  rankedOnly?: boolean;
  minPopularity?: number;
  maxDifficulty?: number;
  orderBy?: "popularity" | "difficulty" | "asoOpportunity" | "adsOpportunity" | "lastPosition" | "lastUpdated" | "text";
  orderDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

const ORDER_COLUMNS: Record<NonNullable<KeywordFilter["orderBy"]>, string> = {
  popularity: "k.ZPOPULARITY",
  difficulty: "k.ZDIFFICULTY",
  asoOpportunity: "k.ZASOOPPORTUNITY",
  adsOpportunity: "k.ZADSOPPORTUNITY",
  lastPosition: "k.ZLASTPOSITION",
  lastUpdated: "k.ZLASTUPDATED",
  text: "k.ZTEXT",
};

type Row = Record<string, unknown>;

export interface WalInfo {
  /** True when the store was snapshotted (main + -wal + -shm) before opening. */
  copied: boolean;
  walBytes: number;
  walMtime: string | null;
}

function fileStamp(p: string): string {
  if (!existsSync(p)) return "missing";
  const st = statSync(p);
  return `${st.size}:${st.mtimeMs}`;
}

/**
 * Copy the SQLite main file and its WAL/SHM siblings into a fresh temp dir.
 * Altis may be writing concurrently, so the copy is retried when the WAL
 * changed while we were copying (a torn snapshot). SQLite ignores a partial
 * trailing WAL frame, but main-file/WAL skew is avoided outright this way.
 * Returns the copied main-file path, the temp dir, and WAL size for diagnostics.
 */
export function snapshotStore(path: string, maxAttempts = 4): { copyPath: string; dir: string; wal: WalInfo } {
  const dir = mkdtempSync(join(tmpdir(), "altis-mcp-"));
  const name = basename(path);
  for (let attempt = 1; ; attempt++) {
    const before = [path, path + "-wal"].map(fileStamp).join("|");
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = path + suffix;
      if (existsSync(src)) copyFileSync(src, join(dir, name + suffix));
      else rmSync(join(dir, name + suffix), { force: true });
    }
    const after = [path, path + "-wal"].map(fileStamp).join("|");
    if (before === after || attempt >= maxAttempts) {
      let walBytes = 0;
      let walMtime: string | null = null;
      if (existsSync(path + "-wal")) {
        const st = statSync(path + "-wal");
        walBytes = st.size;
        walMtime = st.mtime.toISOString();
      }
      return { copyPath: join(dir, name), dir, wal: { copied: true, walBytes, walMtime } };
    }
  }
}

export class AltisStore {
  private db: DatabaseSync;
  readonly path: string;
  readonly wal: WalInfo;
  private tempDir: string | null = null;

  constructor(path = storePath()) {
    if (!existsSync(path)) {
      throw new Error(
        `Altis database not found at ${path}. Is Altis ASO installed and has it been opened at least once? ` +
          `Set ALTIS_STORE_PATH to override the location.`,
      );
    }
    this.path = path;
    const snap = snapshotStore(path);
    this.tempDir = snap.dir;
    this.wal = snap.wal;
    // The copy is private, so a read-write open is safe and lets SQLite replay the WAL.
    this.db = new DatabaseSync(snap.copyPath);
  }

  close(): void {
    this.db.close();
    if (this.tempDir) {
      rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
  }

  /** Keyword count for one tracked app, straight from the (WAL-fresh) store. */
  keywordCount(appId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM ZKEYWORD WHERE ZTRACKEDAPP = ?").get(appId) as Row).c as number;
  }

  /** Lowercased keyword texts tracked for an app (optionally one country). */
  trackedTexts(appId?: number, countryCode?: string): Set<string> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (appId !== undefined) {
      where.push("ZTRACKEDAPP = ?");
      params.push(appId);
    }
    if (countryCode) {
      where.push("UPPER(ZCOUNTRYCODE) = ?");
      params.push(countryCode.toUpperCase());
    }
    const rows = this.db
      .prepare(`SELECT ZTEXT FROM ZKEYWORD ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`)
      .all(...params) as Row[];
    return new Set(rows.map((r) => String(r.ZTEXT ?? "").toLowerCase()).filter(Boolean));
  }

  private mapApp(r: Row): TrackedApp {
    const appleId = text(r.ZAPPLEID);
    return {
      id: r.Z_PK as number,
      name: text(r.ZNAME),
      appleId,
      isExploreContainer: appleId === "explore-altis",
      isFictional: bool(r.ZISFICTIONAL),
      autoSuggestionsEnabled: bool(r.ZAUTOSUGGESTIONSENABLED),
      iconUrl: text(r.ZICONURL),
      createdAt: coreDataDate(r.ZCREATEDAT),
      keywordCount: (r.keywordCount as number) ?? 0,
      bannedKeywords: decodeBlob(r.ZBANNEDKEYWORDS),
      savedSuggestions: decodeBlob(r.ZSAVEDSUGGESTIONS),
    };
  }

  listApps(): TrackedApp[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM ZKEYWORD k WHERE k.ZTRACKEDAPP = a.Z_PK) AS keywordCount
         FROM ZTRACKEDAPP a ORDER BY a.Z_PK`,
      )
      .all() as Row[];
    return rows.map((r) => this.mapApp(r));
  }

  getApp(id: number): TrackedApp | null {
    const r = this.db
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM ZKEYWORD k WHERE k.ZTRACKEDAPP = a.Z_PK) AS keywordCount
         FROM ZTRACKEDAPP a WHERE a.Z_PK = ?`,
      )
      .get(id) as Row | undefined;
    return r ? this.mapApp(r) : null;
  }

  private mapKeyword(r: Row, includeHistory: boolean): Keyword {
    const k: Keyword = {
      id: r.Z_PK as number,
      text: text(r.ZTEXT),
      countryCode: text(r.ZCOUNTRYCODE),
      source: text(r.ZSOURCE),
      appId: num(r.ZTRACKEDAPP),
      appName: text(r.appName),
      explorerAgentId: num(r.ZEXPLORERAGENT),
      agentName: text(r.ZAGENTNAME),
      popularity: num(r.ZPOPULARITY),
      difficulty: num(r.ZDIFFICULTY),
      asoOpportunity: num(r.ZASOOPPORTUNITY),
      adsOpportunity: num(r.ZADSOPPORTUNITY),
      adsPollution: num(r.ZADSPOLLUTION),
      lastPosition: num(r.ZLASTPOSITION),
      isLowFruit: bool(r.ZISLOWFRUIT),
      isVeryLowFruit: bool(r.ZISVERYLOWFRUIT),
      isOpportunity: bool(r.ZISOPPORTUNITY),
      disqualificationReason: text(r.ZDISQUALIFICATIONREASON),
      createdAt: coreDataDate(r.ZCREATEDAT),
      lastUpdated: coreDataDate(r.ZLASTUPDATED),
      popularityDifficultyLastUpdated: coreDataDate(r.ZPOPULARITYDIFFICULTYLASTUPDATED),
    };
    if (includeHistory) {
      const raw = decodeBlob(r.ZPOSITIONHISTORY);
      k.positionHistory = Array.isArray(raw)
        ? raw
            .filter((s) => s && typeof s === "object")
            .map((s: { position?: number; date?: number }) => ({
              position: s.position ?? 0,
              date: coreDataDate(s.date),
            }))
        : [];
    }
    return k;
  }

  listKeywords(f: KeywordFilter = {}, includeHistory = false): { total: number; keywords: Keyword[] } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.appId !== undefined) {
      where.push("k.ZTRACKEDAPP = ?");
      params.push(f.appId);
    }
    if (f.countryCode) {
      where.push("UPPER(k.ZCOUNTRYCODE) = ?");
      params.push(f.countryCode.toUpperCase());
    }
    if (f.source) {
      where.push("k.ZSOURCE = ?");
      params.push(f.source);
    }
    if (f.search) {
      where.push("k.ZTEXT LIKE ?");
      params.push(`%${f.search}%`);
    }
    if (f.lowFruitOnly) where.push("k.ZISLOWFRUIT = 1");
    if (f.veryLowFruitOnly) where.push("k.ZISVERYLOWFRUIT = 1");
    if (f.opportunityOnly) where.push("k.ZISOPPORTUNITY = 1");
    if (f.rankedOnly) where.push("k.ZLASTPOSITION > 0");
    if (f.minPopularity !== undefined) {
      where.push("k.ZPOPULARITY >= ?");
      params.push(f.minPopularity);
    }
    if (f.maxDifficulty !== undefined) {
      where.push("k.ZDIFFICULTY <= ?");
      params.push(f.maxDifficulty);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderCol = ORDER_COLUMNS[f.orderBy ?? "lastUpdated"];
    const dir = (f.orderDir ?? (f.orderBy === "text" || f.orderBy === "lastPosition" || f.orderBy === "difficulty" ? "asc" : "desc")).toUpperCase();
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    const offset = Math.max(f.offset ?? 0, 0);

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM ZKEYWORD k ${whereSql}`).get(...params) as Row
    ).c as number;
    const rows = this.db
      .prepare(
        `SELECT k.*, a.ZNAME AS appName FROM ZKEYWORD k
         LEFT JOIN ZTRACKEDAPP a ON a.Z_PK = k.ZTRACKEDAPP
         ${whereSql} ORDER BY ${orderCol} ${dir}, k.Z_PK LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Row[];
    return { total, keywords: rows.map((r) => this.mapKeyword(r, includeHistory)) };
  }

  getKeyword(id: number): Keyword | null {
    const r = this.db
      .prepare(
        `SELECT k.*, a.ZNAME AS appName FROM ZKEYWORD k
         LEFT JOIN ZTRACKEDAPP a ON a.Z_PK = k.ZTRACKEDAPP WHERE k.Z_PK = ?`,
      )
      .get(id) as Row | undefined;
    return r ? this.mapKeyword(r, true) : null;
  }

  findKeyword(textValue: string, countryCode?: string, appId?: number): Keyword[] {
    const where = ["LOWER(k.ZTEXT) = LOWER(?)"];
    const params: (string | number)[] = [textValue];
    if (countryCode) {
      where.push("UPPER(k.ZCOUNTRYCODE) = ?");
      params.push(countryCode.toUpperCase());
    }
    if (appId !== undefined) {
      where.push("k.ZTRACKEDAPP = ?");
      params.push(appId);
    }
    const rows = this.db
      .prepare(
        `SELECT k.*, a.ZNAME AS appName FROM ZKEYWORD k
         LEFT JOIN ZTRACKEDAPP a ON a.Z_PK = k.ZTRACKEDAPP WHERE ${where.join(" AND ")}`,
      )
      .all(...params) as Row[];
    return rows.map((r) => this.mapKeyword(r, true));
  }

  private mapAgent(r: Row): ExplorerAgent {
    return {
      id: r.Z_PK as number,
      name: text(r.ZNAME),
      seedKeyword: text(r.ZSEEDKEYWORD),
      mainSearchCountryCode: text(r.ZMAINSEARCHCOUNTRYCODE),
      selectedCountries: decodeBlob(r.ZSELECTEDCOUNTRIES),
      allowedIntentions: decodeBlob(r.ZALLOWEDINTENTIONS),
      isActive: bool(r.ZISACTIVE),
      isPaused: bool(r.ZISPAUSED),
      appId: num(r.ZTRACKEDAPP),
      keywordsAnalyzed: num(r.ZKEYWORDSANALYZED),
      keywordsFound: num(r.ZKEYWORDSFOUND),
      lowFruitsFound: num(r.ZLOWFRUITSFOUND),
      veryLowFruitsFound: num(r.ZVERYLOWFRUITSFOUND),
      opportunitiesFound: num(r.ZOPPORTUNITIESFOUND),
      asoLowFruitsFound: num(r.ZASOLOWFRUITSFOUND),
      asoVeryLowFruitsFound: num(r.ZASOVERYLOWFRUITSFOUND),
      adsLowFruitsFound: num(r.ZADSLOWFRUITSFOUND),
      adsVeryLowFruitsFound: num(r.ZADSVERYLOWFRUITSFOUND),
      plannedVariationsCount: num(r.ZPLANNEDVARIATIONSCOUNT),
      pendingAsaCount: num(r.ZPENDINGASACOUNT),
      criteria: {
        minPopularity: num(r.ZMINPOPULARITY),
        maxDifficulty: num(r.ZMAXDIFFICULTY),
        minAsoOpportunity: num(r.ZMINASOOPPORTUNITY),
        minAdsOpportunity: num(r.ZMINADSOPPORTUNITY),
        minVeryLowPopularity: num(r.ZMINVERYLOWPOPULARITY),
        maxVeryLowDifficulty: num(r.ZMAXVERYLOWDIFFICULTY),
        minVeryLowAsoOpportunity: num(r.ZMINVERYLOWASOOPPORTUNITY),
        minVeryLowAdsOpportunity: num(r.ZMINVERYLOWADSOPPORTUNITY),
        maxAverageRating: num(r.ZMAXAVERAGERATING),
        maxAverageReviews: num(r.ZMAXAVERAGEREVIEWS),
        maxAverageAppAge: num(r.ZMAXAVERAGEAPPAGE),
        minRatioPopularityOverDifficulty: num(r.ZMINRATIOPOPULARITYOVERDIFFICULTY),
        minDemandLevel: text(r.ZMINDEMANDLEVEL),
        requireAllCriteria: bool(r.ZREQUIREALLCRITERIA),
      },
      createdAt: coreDataDate(r.ZCREATEDAT),
      lastRunAt: coreDataDate(r.ZLASTRUNAT),
      firstKeywordAnalyzedAt: coreDataDate(r.ZFIRSTKEYWORDANALYZEDAT),
      lastPauseTime: coreDataDate(r.ZLASTPAUSETIME),
      totalActiveTimeSeconds: num(r.ZTOTALACTIVETIME),
    };
  }

  listAgents(): ExplorerAgent[] {
    const rows = this.db.prepare("SELECT * FROM ZEXPLORERAGENT ORDER BY Z_PK").all() as Row[];
    return rows.map((r) => this.mapAgent(r));
  }

  listVolumeEstimates(keyword?: string, countryCode?: string): VolumeEstimate[] {
    const where: string[] = [];
    const params: string[] = [];
    if (keyword) {
      where.push("LOWER(ZKEYWORD) = LOWER(?)");
      params.push(keyword);
    }
    if (countryCode) {
      where.push("UPPER(ZCOUNTRYCODE) = ?");
      params.push(countryCode.toUpperCase());
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM ZKEYWORDVOLUMEESTIMATE ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ZUPDATEDAT DESC LIMIT 500`,
      )
      .all(...params) as Row[];
    return rows.map((r) => ({
      id: r.Z_PK as number,
      keyword: text(r.ZKEYWORD),
      countryCode: text(r.ZCOUNTRYCODE),
      level: text(r.ZLEVEL),
      explanation: text(r.ZEXPLANATION),
      updatedAt: coreDataDate(r.ZUPDATEDAT),
    }));
  }

  /** Aggregate stats, optionally scoped to one app. */
  stats(appId?: number) {
    const scope = appId !== undefined ? "WHERE ZTRACKEDAPP = ?" : "";
    const params = appId !== undefined ? [appId] : [];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS keywords,
                SUM(ZLASTPOSITION BETWEEN 1 AND 10) AS top10,
                SUM(ZLASTPOSITION BETWEEN 1 AND 50) AS top50,
                SUM(ZLASTPOSITION BETWEEN 1 AND 100) AS top100,
                SUM(ZLASTPOSITION > 0) AS ranked,
                SUM(ZISLOWFRUIT = 1) AS lowFruits,
                SUM(ZISVERYLOWFRUIT = 1) AS veryLowFruits,
                SUM(ZISOPPORTUNITY = 1) AS opportunities,
                AVG(NULLIF(ZPOPULARITY, 0)) AS avgPopularity,
                AVG(NULLIF(ZDIFFICULTY, 0)) AS avgDifficulty,
                MAX(ZLASTUPDATED) AS lastUpdated
         FROM ZKEYWORD ${scope}`,
      )
      .get(...params) as Row;
    const byCountry = this.db
      .prepare(
        `SELECT ZCOUNTRYCODE AS country, COUNT(*) AS keywords, SUM(ZLASTPOSITION > 0) AS ranked
         FROM ZKEYWORD ${scope} GROUP BY ZCOUNTRYCODE ORDER BY keywords DESC`,
      )
      .all(...params) as Row[];
    const bySource = this.db
      .prepare(`SELECT ZSOURCE AS source, COUNT(*) AS keywords FROM ZKEYWORD ${scope} GROUP BY ZSOURCE`)
      .all(...params) as Row[];
    return {
      ...totals,
      lastUpdated: coreDataDate(totals.lastUpdated),
      byCountry,
      bySource,
    };
  }
}
