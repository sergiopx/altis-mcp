/**
 * Cross-process Apple budget: limiter state in screen.sqlite so a Claude Code
 * session's server and a dev session's server (and their detached workers)
 * pace against one clock. See docs/adr/0001-shared-apple-limiter-in-sqlite.md.
 *
 * The slot claim runs in a BEGIN IMMEDIATE transaction: read the row, decide,
 * write lastCallAt. SQLite's write lock makes two processes' claims serial, so
 * both cannot pass within one pace interval. busy_timeout covers contention.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ClaimResult, LimiterBackend, SharedLimiterState } from "./ratelimit.js";
import { searchLimiter, suggestLimiter } from "./ratelimit.js";
import { screenStorePath } from "./screenstore.js";

type Row = Record<string, unknown>;

export class SqliteLimiterBackend implements LimiterBackend {
  private db: DatabaseSync;

  constructor(path = screenStorePath()) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS limiters (
        name TEXT PRIMARY KEY,
        last_call_at INTEGER NOT NULL DEFAULT 0,
        last_rate_limit_at INTEGER,
        backoff_until INTEGER NOT NULL DEFAULT 0,
        consecutive INTEGER NOT NULL DEFAULT 0,
        multiplier REAL NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  read(name: string): SharedLimiterState {
    const r = this.db.prepare("SELECT * FROM limiters WHERE name = ?").get(name) as Row | undefined;
    return r ? mapRow(r) : { lastCallAt: 0, lastRateLimitAt: null, backoffUntil: 0, consecutive: 0, multiplier: 1 };
  }

  claim(name: string, paceMs: number, now: number): ClaimResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureRow(name);
      const state = this.read(name);
      const nextSafeAt = Math.max(state.lastCallAt + paceMs, state.backoffUntil);
      let result: ClaimResult;
      if (now >= nextSafeAt) {
        this.db.prepare("UPDATE limiters SET last_call_at = ?, updated_at = ? WHERE name = ?").run(now, new Date(now).toISOString(), name);
        result = { ok: true, state: { ...state, lastCallAt: now } };
      } else {
        result = { ok: false, nextSafeAt, state };
      }
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  update(name: string, patch: Partial<SharedLimiterState>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureRow(name);
      const cur = this.read(name);
      const next: SharedLimiterState = { ...cur, ...patch };
      // Never move shared backoff/consecutive backwards through a stale writer, except an explicit reset to 0.
      if (patch.backoffUntil !== undefined && patch.backoffUntil !== 0) next.backoffUntil = Math.max(cur.backoffUntil, patch.backoffUntil);
      if (patch.multiplier !== undefined) next.multiplier = Math.max(cur.multiplier, patch.multiplier);
      this.db
        .prepare(`UPDATE limiters SET last_rate_limit_at = ?, backoff_until = ?, consecutive = ?, multiplier = ?, updated_at = ? WHERE name = ?`)
        .run(next.lastRateLimitAt, next.backoffUntil, next.consecutive, next.multiplier, new Date().toISOString(), name);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private ensureRow(name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO limiters (name, updated_at) VALUES (?, ?)").run(name, new Date().toISOString());
  }
}

function mapRow(r: Row): SharedLimiterState {
  return {
    lastCallAt: Number(r.last_call_at ?? 0),
    lastRateLimitAt: r.last_rate_limit_at === null || r.last_rate_limit_at === undefined ? null : Number(r.last_rate_limit_at),
    backoffUntil: Number(r.backoff_until ?? 0),
    consecutive: Number(r.consecutive ?? 0),
    multiplier: Number(r.multiplier ?? 1),
  };
}

let attached: SqliteLimiterBackend | null = null;

/** Attach both process-wide limiters to the shared store. Safe to call once per process; failures leave the limiters local. */
export function attachSharedLimiters(path?: string): boolean {
  if (attached) return true;
  try {
    attached = new SqliteLimiterBackend(path);
    searchLimiter.attach(attached);
    suggestLimiter.attach(attached);
    return true;
  } catch {
    attached = null;
    return false;
  }
}
