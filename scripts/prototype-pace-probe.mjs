#!/usr/bin/env node
// PROTOTYPE — throwaway. Not used by the server. Delete when the question is answered.
//
// Question: what is the fastest spacing between itunes.apple.com/search calls
// that Apple tolerates from this machine, and how long does a 403 lock us out?
//
// Method: walk a ladder of paces from slow to fast, N calls each, shaped like a
// real rank check (limit=200, unique terms so nothing is cached). At the first
// 403, measure the lockout (poll every 30 s), then bisect between the last
// passing and first failing pace to within --step ms, then confirm the winner
// with a --confirm-call run.
//
// Run:   pnpm prototype:pace                   (defaults below)
//        pnpm prototype:pace -- --paces 3200,2400,1800 --calls 40 --cooldown 90
//        pnpm prototype:pace -- --dry           (print the plan, no calls)
//        pnpm prototype:pace -- --force         (ignore running screen jobs; they will skew the result)
//
// Bypasses the server's limiter on purpose: the probe IS the limiter here.
//
// VERDICT 2026-09-03 (US, limit=200, from this machine):
//   20, 25, 30, 35, 40, 50 calls/min: 40 calls each, no 403, in every run.
//   60 calls/min: 100 calls clean in isolation (run 3), but a 403 at cumulative
//     call ~286 in run 2 after ~20 min of mixed load. Lockout after the 403: ~60 s.
//   Sequential callers are capped near 20/min by ~3 s latency whatever the pace.
//   Decision: DEFAULT_SEARCH_PACE_MS = 1500 (40/min), 2x faster than 3200, below the edge.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const PACES = String(arg("paces", "3000,2400,2000,1700,1500,1200,1000")).split(",").map(Number); // 20,25,30,35,40,50,60 calls/min
const CALLS = Number(arg("calls", 40));
const COOLDOWN_S = Number(arg("cooldown", 90));
const COUNTRY = String(arg("country", "us"));
const LIMIT = Number(arg("limit", 200));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// Unique, plausible fitness-ish terms so the CDN never answers from cache.
const A = ["plate", "barbell", "squat", "deadlift", "bench", "wendler", "powerlifting", "1rm", "kettlebell", "rowing", "cycling", "yoga", "pilates", "boxing", "sprint"];
const B = ["calculator", "tracker", "log", "planner", "timer", "coach", "chart", "program", "journal", "counter"];
let n = 0;
const nextTerm = () => `${A[n % A.length]} ${B[Math.floor(n / A.length) % B.length]} ${(n++).toString(36)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";

async function call() {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", nextTerm());
  url.searchParams.set("media", "software");
  url.searchParams.set("entity", "software");
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("limit", String(LIMIT));
  const s = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const ms = Date.now() - s;
  let count = null;
  if (res.ok) count = (await res.json()).resultCount;
  else await res.text();
  return { status: res.status, ms, count, retryAfter: res.headers.get("retry-after") };
}

// ---------------------------------------------------------------- plan

const plan = PACES.map((p) => ({ paceMs: p, calls: CALLS, callsPerMin: +(60_000 / p).toFixed(1), seconds: Math.round((p * CALLS) / 1000) }));
const totalMin = Math.round((plan.reduce((a, l) => a + l.seconds, 0) + COOLDOWN_S * (PACES.length - 1)) / 60);
console.log(`PROTOTYPE pace probe · country ${COUNTRY} · limit ${LIMIT} · ${CALLS} calls per level · ${COOLDOWN_S}s between levels · worst case ~${totalMin} min`);
console.table(plan);
if (flag("dry")) process.exit(0);

// ---------------------------------------------------------------- guard

const storePath = join(process.env.ALTIS_MCP_DATA_DIR ?? join(homedir(), "Library/Application Support/altis-mcp"), "screen.sqlite");
if (existsSync(storePath)) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  const running = db.prepare("SELECT id, pid FROM jobs WHERE status = 'running'").all();
  db.close();
  const alive = running.filter((j) => {
    try { process.kill(j.pid, 0); return true; } catch { return false; }
  });
  if (alive.length && !flag("force")) {
    console.error(`Refusing: ${alive.length} screen job(s) are running (${alive.map((j) => j.id).join(", ")}).`);
    console.error("Apple sees the sum of all callers, so the probe would be wrong and would stall those jobs. Cancel them or pass --force.");
    process.exit(2);
  }
}

// ---------------------------------------------------------------- ladder + bisect + confirm

const STEP_MS = Number(arg("step", 200));      // stop bisecting when pass and fail paces are this close
const CONFIRM = Number(arg("confirm", 100));   // calls at the winning pace to prove it holds
const state = { levels: [], lockouts: [], fastestPassingPaceMs: null, slowestFailingPaceMs: null, confirmed: null };
const printState = () => console.log("STATE", JSON.stringify(state));

async function runLevel(paceMs, calls, label) {
  // Calls start every paceMs regardless of whether the previous one has answered
  // (a single search call takes ~3 s, so paces under that need overlap). This is
  // what a multi-worker server does; a sequential caller is capped at ~20/min.
  const level = { label, paceMs, callsPerMin: +(60_000 / paceMs).toFixed(1), calls, ok: 0, failed: 0, maxInFlight: 0, avgLatencyMs: 0, firstFailAtCall: null, retryAfter: null, startedAt: new Date().toISOString() };
  state.levels.push(level);
  console.log(`\n▶ ${label} pace ${paceMs} ms (${level.callsPerMin}/min), ${calls} calls, overlapping`);
  const lat = [];
  let inFlight = 0, failed = false;
  const pending = [];
  for (let i = 1; i <= calls && !failed; i++) {
    const startedAt = Date.now();
    inFlight++;
    level.maxInFlight = Math.max(level.maxInFlight, inFlight);
    pending.push(
      call()
        .then((r) => {
          lat.push(r.ms);
          level.avgLatencyMs = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
          if (r.status === 200) {
            level.ok++;
            console.log(`${stamp()}  #${String(i).padStart(3)}  200  ${String(r.ms).padStart(4)} ms  inflight=${inFlight}  results=${r.count}`);
          } else {
            level.failed++;
            if (!failed) {
              failed = true;
              level.firstFailAtCall = i;
              level.retryAfter = r.retryAfter;
              console.log(`${stamp()}  #${String(i).padStart(3)}  ${r.status}  ${String(r.ms).padStart(4)} ms  retry-after=${r.retryAfter ?? "none"}  ← rate limited after ${Math.round((i * paceMs) / 1000)}s at this pace`);
            }
          }
        })
        .catch((e) => console.log(`${stamp()}  #${i}  network error ${e.message}`))
        .finally(() => inFlight--),
    );
    if (i < calls) await sleep(Math.max(0, paceMs - (Date.now() - startedAt)));
  }
  await Promise.all(pending);
  printState();
  return !failed;
}

async function waitLockout() {
  const lockStart = Date.now();
  const probeEvery = 30_000;
  console.log(`\n▶ lockout: one call every ${probeEvery / 1000}s until 200`);
  for (;;) {
    await sleep(probeEvery);
    const r = await call();
    const el = Math.round((Date.now() - lockStart) / 1000);
    console.log(`${stamp()}  after ${el}s  ${r.status}  retry-after=${r.retryAfter ?? "none"}`);
    if (r.status === 200 || el > 1800) {
      state.lockouts.push(r.status === 200 ? el : ">1800");
      printState();
      await cool(); // the window that tripped the limit is still warm; let it drain before the next level
      return;
    }
  }
}

const cool = async () => { console.log(`cooling ${COOLDOWN_S}s`); await sleep(COOLDOWN_S * 1000); };

// 1. ladder, slow → fast, until the first 403
for (const paceMs of PACES) {
  if (await runLevel(paceMs, CALLS, "ladder")) {
    state.fastestPassingPaceMs = paceMs;
    await cool();
  } else {
    state.slowestFailingPaceMs = paceMs;
    await waitLockout();
    break;
  }
}

// 2. bisect between the last pass and the first fail
while (state.fastestPassingPaceMs !== null && state.slowestFailingPaceMs !== null && state.fastestPassingPaceMs - state.slowestFailingPaceMs > STEP_MS) {
  const mid = Math.round((state.fastestPassingPaceMs + state.slowestFailingPaceMs) / 2 / 50) * 50;
  if (await runLevel(mid, CALLS, "bisect")) {
    state.fastestPassingPaceMs = mid;
    await cool();
  } else {
    state.slowestFailingPaceMs = mid;
    await waitLockout();
  }
}

// 3. confirm the winner holds for a long run; back off by STEP_MS on failure and retry
while (state.fastestPassingPaceMs !== null && state.confirmed === null) {
  if (await runLevel(state.fastestPassingPaceMs, CONFIRM, "confirm")) {
    state.confirmed = state.fastestPassingPaceMs;
  } else {
    state.slowestFailingPaceMs = state.fastestPassingPaceMs;
    state.fastestPassingPaceMs += STEP_MS;
    await waitLockout();
  }
}

console.log("\nVERDICT");
console.log(`  confirmed pace       : ${state.confirmed ?? "none"} ms  (${state.confirmed ? (60_000 / state.confirmed).toFixed(1) : "-"} calls/min over ${CONFIRM} calls)`);
console.log(`  slowest failing pace : ${state.slowestFailingPaceMs ?? "none seen"} ms`);
console.log(`  lockouts observed    : ${state.lockouts.join(", ") || "none"} s`);
for (const l of state.levels.filter((l) => l.failed)) console.log(`  403 at ${l.paceMs} ms after ${l.firstFailAtCall} calls (${Math.round((l.firstFailAtCall * l.paceMs) / 1000)}s), Retry-After ${l.retryAfter ?? "absent"}`);
printState();
