/**
 * Server-owned persistence for the screening loop: every rank check and
 * autocomplete response, so batches are resumable, scoring queries need no
 * refetch, and positions can be compared over time for keywords that were
 * never tracked in Altis.
 *
 * Location: ~/Library/Application Support/altis-mcp/screen.sqlite
 * (override the directory with ALTIS_MCP_DATA_DIR).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BatchItemResult, RankResult, TopApp } from "./apple.js";
import { summarizeTop10 } from "./apple.js";

export function dataDir(): string {
  return process.env.ALTIS_MCP_DATA_DIR ?? join(homedir(), "Library/Application Support/altis-mcp");
}

export function screenStorePath(): string {
  return join(dataDir(), "screen.sqlite");
}

export const DEFAULT_SUGGESTION_TTL_MS = 7 * 86_400_000;

export interface RankRow {
  id: number;
  term: string;
  country: string;
  appId: string;
  position: number | null;
  checkedTop: number;
  checkedAt: string;
  source: string;
  topApps: TopApp[];
  error: string | null;
}

export interface ScreenResultRow {
  term: string;
  country: string;
  appId: string;
  position: number | null;
  checkedTop: number;
  checkedAt: string;
  source: string;
  resultCount: number;
  maxReviews: number | null;
  sumReviews: number | null;
  avgRating: number | null;
  newestAgeDays: number | null;
  medianAgeDays: number | null;
  dominantGenre: string | null;
  checks: number;
}

export interface ScreenResultsFilter {
  country?: string;
  appId?: string;
  /** Only terms where the app ranks at or better than this position (e.g. 100). */
  maxPosition?: number;
  minPosition?: number;
  rankedOnly?: boolean;
  maxTop10Reviews?: number;
  /** ISO timestamp; only rows checked at/after it. */
  since?: string;
  orderBy?: "position" | "checkedAt" | "maxReviews" | "medianAgeDays" | "term";
  orderDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

type Row = Record<string, unknown>;

export type JobStatus = "running" | "done" | "aborted" | "cancelled" | "failed";

export interface JobRecord {
  id: string;
  kind: "screen" | "batch";
  status: JobStatus;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  input: unknown;
  state: unknown;
}

export class ScreenStore {
  private db: DatabaseSync;
  readonly path: string;

  constructor(path = screenStorePath()) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rank_checks (
        id INTEGER PRIMARY KEY,
        term TEXT NOT NULL,
        country TEXT NOT NULL,
        app_id TEXT NOT NULL,
        position INTEGER,
        checked_top INTEGER NOT NULL,
        checked_at TEXT NOT NULL,
        source TEXT NOT NULL,
        top_apps TEXT NOT NULL,
        max_reviews INTEGER, sum_reviews INTEGER, avg_rating REAL,
        newest_age_days INTEGER, median_age_days REAL, dominant_genre TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS rank_checks_key ON rank_checks(term, country, app_id, checked_at DESC);
      CREATE TABLE IF NOT EXISTS suggestions (
        term TEXT NOT NULL,
        country TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        suggestions TEXT NOT NULL,
        PRIMARY KEY (term, country)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        input TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_candidates (
        job_id TEXT NOT NULL,
        term TEXT NOT NULL,
        country TEXT NOT NULL,
        status TEXT NOT NULL,
        position INTEGER,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, term, country)
      );
      CREATE INDEX IF NOT EXISTS job_candidates_status ON job_candidates(job_id, status);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ rank checks

  saveRank(r: RankResult | BatchItemResult, source: string): void {
    const top = r.topApps ?? [];
    const s = r.top10 ?? summarizeTop10(top);
    this.db
      .prepare(
        `INSERT INTO rank_checks (term, country, app_id, position, checked_top, checked_at, source, top_apps,
           max_reviews, sum_reviews, avg_rating, newest_age_days, median_age_days, dominant_genre, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.term.toLowerCase(),
        r.country.toUpperCase(),
        r.appId,
        r.position ?? null,
        r.checkedTop ?? 0,
        r.checkedAt ?? new Date().toISOString(),
        source,
        JSON.stringify(top),
        s.maxReviews, s.sumReviews, s.avgRating, s.newestAgeDays, s.medianAgeDays, s.dominantGenre,
        "error" in r && r.error ? r.error : null,
      );
  }

  /** Most recent successful check for a term, if newer than `maxAgeMs`. */
  latestRank(term: string, country: string, appId: string, maxAgeMs?: number): RankRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM rank_checks WHERE term = ? AND country = ? AND app_id = ? AND error IS NULL
         ORDER BY checked_at DESC LIMIT 1`,
      )
      .get(term.toLowerCase(), country.toUpperCase(), appId) as Row | undefined;
    if (!r) return null;
    if (maxAgeMs !== undefined && Date.now() - Date.parse(r.checked_at as string) > maxAgeMs) return null;
    return mapRank(r);
  }

  history(term: string, country: string, appId?: string): RankRow[] {
    const where = ["term = ?", "country = ?"];
    const params: string[] = [term.toLowerCase(), country.toUpperCase()];
    if (appId) {
      where.push("app_id = ?");
      params.push(appId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM rank_checks WHERE ${where.join(" AND ")} ORDER BY checked_at ASC`)
      .all(...params) as Row[];
    return rows.map(mapRank);
  }

  /** Latest successful row per (term, country, appId) with the scoring inputs. */
  results(f: ScreenResultsFilter = {}): { total: number; results: ScreenResultRow[] } {
    const where: string[] = ["r.error IS NULL"];
    const params: (string | number)[] = [];
    if (f.country) {
      where.push("r.country = ?");
      params.push(f.country.toUpperCase());
    }
    if (f.appId) {
      where.push("r.app_id = ?");
      params.push(f.appId);
    }
    if (f.rankedOnly || f.maxPosition !== undefined) where.push("r.position IS NOT NULL");
    if (f.maxPosition !== undefined) {
      where.push("r.position <= ?");
      params.push(f.maxPosition);
    }
    if (f.minPosition !== undefined) {
      where.push("r.position >= ?");
      params.push(f.minPosition);
    }
    if (f.maxTop10Reviews !== undefined) {
      where.push("r.max_reviews <= ?");
      params.push(f.maxTop10Reviews);
    }
    if (f.since) {
      where.push("r.checked_at >= ?");
      params.push(f.since);
    }
    const orderCol =
      { position: "r.position", checkedAt: "r.checked_at", maxReviews: "r.max_reviews", medianAgeDays: "r.median_age_days", term: "r.term" }[
        f.orderBy ?? "position"
      ];
    const dir = (f.orderDir ?? (f.orderBy === "checkedAt" ? "desc" : "asc")).toUpperCase();
    const limit = Math.min(Math.max(f.limit ?? 200, 1), 5000);
    const offset = Math.max(f.offset ?? 0, 0);
    const base = `FROM rank_checks r
      JOIN (SELECT term, country, app_id, MAX(checked_at) AS checked_at, COUNT(*) AS checks
            FROM rank_checks WHERE error IS NULL GROUP BY term, country, app_id) latest
        ON latest.term = r.term AND latest.country = r.country AND latest.app_id = r.app_id AND latest.checked_at = r.checked_at
      WHERE ${where.join(" AND ")}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params) as Row).c as number;
    const rows = this.db
      .prepare(`SELECT r.*, latest.checks AS checks ${base} ORDER BY ${orderCol} IS NULL, ${orderCol} ${dir}, r.term LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return {
      total,
      results: rows.map((r) => ({
        term: r.term as string,
        country: r.country as string,
        appId: r.app_id as string,
        position: (r.position as number | null) ?? null,
        checkedTop: r.checked_top as number,
        checkedAt: r.checked_at as string,
        source: r.source as string,
        resultCount: r.checked_top as number,
        maxReviews: (r.max_reviews as number | null) ?? null,
        sumReviews: (r.sum_reviews as number | null) ?? null,
        avgRating: (r.avg_rating as number | null) ?? null,
        newestAgeDays: (r.newest_age_days as number | null) ?? null,
        medianAgeDays: (r.median_age_days as number | null) ?? null,
        dominantGenre: (r.dominant_genre as string | null) ?? null,
        checks: r.checks as number,
      })),
    };
  }

  /** Distinct terms already checked for an app/country (any time, or since a cutoff). */
  checkedTerms(appId: string, country: string, sinceMs?: number): Set<string> {
    const params: (string | number)[] = [appId, country.toUpperCase()];
    let sql = "SELECT DISTINCT term FROM rank_checks WHERE app_id = ? AND country = ? AND error IS NULL";
    if (sinceMs !== undefined) {
      sql += " AND checked_at >= ?";
      params.push(new Date(sinceMs).toISOString());
    }
    return new Set((this.db.prepare(sql).all(...params) as Row[]).map((r) => r.term as string));
  }

  /** Distinct top-app names seen in stored SERPs for a country (no Apple calls). */
  knownAppNames(country: string, limit = 5000): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT json_extract(a.value, '$.trackName') AS name
         FROM rank_checks r, json_each(r.top_apps) a
         WHERE r.country = ? AND name IS NOT NULL LIMIT ?`,
      )
      .all(country.toUpperCase(), limit) as Row[];
    return rows.map((r) => r.name as string);
  }

  // ------------------------------------------------------------ jobs

  saveJob(j: JobRecord): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, status, pid, created_at, updated_at, finished_at, cancel_requested, input, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, pid = excluded.pid, updated_at = excluded.updated_at,
           finished_at = excluded.finished_at, state = excluded.state`,
      )
      .run(j.id, j.kind, j.status, j.pid, j.createdAt, j.updatedAt, j.finishedAt, 0, JSON.stringify(j.input), JSON.stringify(j.state));
  }

  getJob(id: string): (JobRecord & { cancelRequested: boolean }) | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? mapJob(r) : null;
  }

  listJobs(status?: string, limit = 50): Array<JobRecord & { cancelRequested: boolean }> {
    const rows = status
      ? (this.db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit) as Row[])
      : (this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]);
    return rows.map(mapJob);
  }

  requestJobCancel(id: string): boolean {
    return this.db.prepare("UPDATE jobs SET cancel_requested = 1 WHERE id = ?").run(id).changes > 0;
  }

  jobCancelRequested(id: string): boolean {
    const r = this.db.prepare("SELECT cancel_requested AS c FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r?.c === 1;
  }

  addJobCandidate(jobId: string, term: string, country: string, status: "pending" | "skipped"): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO job_candidates (job_id, term, country, status, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(jobId, term.toLowerCase(), country.toUpperCase(), status, new Date().toISOString()).changes > 0
    );
  }

  updateJobCandidate(jobId: string, term: string, country: string, status: "done" | "error" | "cancelled", position: number | null, error?: string): void {
    this.db
      .prepare(`UPDATE job_candidates SET status = ?, position = ?, error = ?, updated_at = ? WHERE job_id = ? AND term = ? AND country = ?`)
      .run(status, position, error ?? null, new Date().toISOString(), jobId, term.toLowerCase(), country.toUpperCase());
  }

  /** Mark every still-pending candidate of a job (e.g. after a cancel or abort). */
  finishPendingCandidates(jobId: string, status: "cancelled" | "error", error: string): number {
    return Number(
      this.db
        .prepare(`UPDATE job_candidates SET status = ?, error = ?, updated_at = ? WHERE job_id = ? AND status = 'pending'`)
        .run(status, error, new Date().toISOString(), jobId).changes,
    );
  }

  jobCandidateCounts(jobId: string): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM job_candidates WHERE job_id = ? GROUP BY status").all(jobId) as Row[];
    return Object.fromEntries(rows.map((r) => [r.status as string, r.n as number]));
  }

  /** Terms still waiting for a rank check across running jobs. */
  pendingSummary(): { runningJobs: number; pendingTerms: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(DISTINCT j.id) AS jobs, COUNT(c.term) AS terms FROM jobs j
         LEFT JOIN job_candidates c ON c.job_id = j.id AND c.status = 'pending'
         WHERE j.status = 'running'`,
      )
      .get() as Row;
    return { runningJobs: r.jobs as number, pendingTerms: r.terms as number };
  }

  // ------------------------------------------------------------ suggestions cache

  getSuggestions(term: string, country: string, ttlMs = DEFAULT_SUGGESTION_TTL_MS): { suggestions: string[]; fetchedAt: string } | null {
    const r = this.db
      .prepare("SELECT fetched_at, suggestions FROM suggestions WHERE term = ? AND country = ?")
      .get(term.toLowerCase(), country.toUpperCase()) as Row | undefined;
    if (!r) return null;
    const fetchedAt = r.fetched_at as string;
    if (Date.now() - Date.parse(fetchedAt) > ttlMs) return null;
    return { suggestions: JSON.parse(r.suggestions as string) as string[], fetchedAt };
  }

  saveSuggestions(term: string, country: string, suggestions: string[]): void {
    this.db
      .prepare(
        `INSERT INTO suggestions (term, country, fetched_at, suggestions) VALUES (?, ?, ?, ?)
         ON CONFLICT(term, country) DO UPDATE SET fetched_at = excluded.fetched_at, suggestions = excluded.suggestions`,
      )
      .run(term.toLowerCase(), country.toUpperCase(), new Date().toISOString(), JSON.stringify(suggestions));
  }

  stats() {
    const checks = this.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT term || ':' || country) AS terms, MAX(checked_at) AS last FROM rank_checks").get() as Row;
    const sugg = this.db.prepare("SELECT COUNT(*) AS n, MAX(fetched_at) AS last FROM suggestions").get() as Row;
    return {
      path: this.path,
      rankChecks: checks.n as number,
      distinctTerms: checks.terms as number,
      lastCheckAt: (checks.last as string | null) ?? null,
      cachedSuggestionQueries: sugg.n as number,
      lastSuggestionAt: (sugg.last as string | null) ?? null,
    };
  }
}

function mapJob(r: Row): JobRecord & { cancelRequested: boolean } {
  return {
    id: r.id as string,
    kind: r.kind as JobRecord["kind"],
    status: r.status as JobStatus,
    pid: (r.pid as number | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    cancelRequested: r.cancel_requested === 1,
    input: JSON.parse(r.input as string),
    state: JSON.parse(r.state as string),
  };
}

function mapRank(r: Row): RankRow {
  return {
    id: r.id as number,
    term: r.term as string,
    country: r.country as string,
    appId: r.app_id as string,
    position: (r.position as number | null) ?? null,
    checkedTop: r.checked_top as number,
    checkedAt: r.checked_at as string,
    source: r.source as string,
    topApps: JSON.parse(r.top_apps as string) as TopApp[],
    error: (r.error as string | null) ?? null,
  };
}

/** Open the store for one operation and close it after. */
export async function withScreenStore<T>(fn: (s: ScreenStore) => T | Promise<T>): Promise<T> {
  const s = new ScreenStore();
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}
