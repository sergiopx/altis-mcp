/**
 * Altis ASO has no API, so keyword writes go through macOS Accessibility
 * (System Events) automation. Adds use exposed controls; deletes need
 * coordinate clicks because "Delete Selected" and its confirmation sheet are
 * invisible to Accessibility. Geometry was measured on 2026-09-03:
 *   - "Delete Selected": 73 px from the window's right edge, 22 px above its bottom;
 *     the free-plan banner (shown when > 30 keywords) pushes it up 90 px.
 *   - Confirmation dialog centered in the window; confirm button 81 px below the window's vertical center.
 *
 * User strings are passed to osascript as argv, never interpolated into script text.
 */
import { execFile } from "node:child_process";

export const PROCESS_NAME = "AltisASO";
export const FREE_PLAN_LIMIT = 30;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Screen point of the "Delete Selected" button for a window; banner shifts it up. */
export function deleteButtonPoint(b: Bounds, bannerVisible: boolean): Point {
  return { x: b.x + b.width - 73, y: b.y + b.height - 22 - (bannerVisible ? 90 : 0) };
}

/** Screen point of the confirm button in the centered delete-confirmation dialog. */
export function confirmButtonPoint(b: Bounds): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 + 81 };
}

/** Split requested keywords into new ones and case-insensitive duplicates of tracked ones. */
export function dedupeAgainst(requested: string[], tracked: Iterable<string>): { fresh: string[]; duplicates: string[] } {
  const have = new Set([...tracked].map((t) => t.trim().toLowerCase()));
  const fresh: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const k = raw.trim();
    if (!k) continue;
    const low = k.toLowerCase();
    if (have.has(low) || seen.has(low)) duplicates.push(k);
    else {
      fresh.push(k);
      seen.add(low);
    }
  }
  return { fresh, duplicates };
}

/** How many of `adding` fit under the free-plan limit given the current count. */
export function slotCheck(current: number, adding: number, limit = FREE_PLAN_LIMIT): { ok: boolean; after: number; overBy: number } {
  const after = current + adding;
  return { ok: after <= limit, after, overBy: Math.max(0, after - limit) };
}

function runOsa(script: string, args: string[] = [], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-", ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`osascript failed: ${stderr.trim() || err.message}`));
      else resolve(stdout.trim());
    }).stdin!.end(script);
  });
}

export async function isAltisRunning(): Promise<boolean> {
  const out = await runOsa(`tell application "System Events" to return (exists process "${PROCESS_NAME}")`);
  return out === "true";
}

export async function isAltisFrontmost(): Promise<boolean> {
  const out = await runOsa(`tell application "System Events" to return (frontmost of process "${PROCESS_NAME}")`);
  return out === "true";
}

export async function activateAltis(): Promise<void> {
  await runOsa(`tell application "System Events" to set frontmost of process "${PROCESS_NAME}" to true
delay 0.4`);
}

/** True when the main window has a sheet or the process shows more than one window (dialog). */
export async function hasOpenSheetOrDialog(): Promise<boolean> {
  const out = await runOsa(`tell application "System Events" to tell process "${PROCESS_NAME}"
  if (count of windows) is 0 then return "nowindow"
  set n to count of windows
  set hasSheet to (exists sheet 1 of window 1)
  if hasSheet or n > 1 then return "true"
  return "false"
end tell`);
  if (out === "nowindow") throw new Error("Altis has no open window");
  return out === "true";
}

export async function windowBounds(): Promise<Bounds> {
  const out = await runOsa(`tell application "System Events" to tell process "${PROCESS_NAME}"
  set p to position of window 1
  set s to size of window 1
  return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
end tell`);
  const [x, y, width, height] = out.split(",").map(Number);
  if ([x, y, width, height].some((n) => !Number.isFinite(n))) throw new Error(`Could not read Altis window bounds: ${out}`);
  return { x, y, width, height };
}

const KEYWORD_GROUP = "group 2 of splitter group 1 of group 1 of window 1";

/** Type a comma-separated list into the Add field and click "Add keywords". */
export async function addKeywordsViaUI(commaList: string): Promise<string> {
  return runOsa(
    `on run argv
  tell application "System Events" to tell process "${PROCESS_NAME}"
    set frontmost to true
    set g to ${KEYWORD_GROUP}
    set tf to text field 1 of g
    set focused of tf to true
    set value of tf to (item 1 of argv)
    delay 0.3
    set clicked to false
    repeat with b in buttons of g
      try
        if (help of b) is "Add keywords" then
          click b
          set clicked to true
        end if
      end try
    end repeat
    if not clicked then error "Add keywords button not found"
    delay 1
    return "ok"
  end tell
end run`,
    [commaList],
  );
}

export async function listRowsFromUI(): Promise<string[]> {
  const out = await runOsa(`tell application "System Events" to tell process "${PROCESS_NAME}"
  set o to outline 1 of scroll area 1 of ${KEYWORD_GROUP}
  set out to ""
  repeat with r in rows of o
    set out to out & (value of static text 1 of group 1 of UI element 1 of r) & linefeed
  end repeat
  return out
end tell`);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function clearSelection(): Promise<void> {
  await runOsa(`tell application "System Events" to tell process "${PROCESS_NAME}"
  set o to outline 1 of scroll area 1 of ${KEYWORD_GROUP}
  repeat with r in rows of o
    if selected of r then set selected of r to false
  end repeat
end tell`);
}

/** Select exactly the row whose text matches (case-insensitive). Returns false when not found. */
export async function selectRow(keyword: string): Promise<boolean> {
  const out = await runOsa(
    `on run argv
  set target to item 1 of argv
  tell application "System Events" to tell process "${PROCESS_NAME}"
    set o to outline 1 of scroll area 1 of ${KEYWORD_GROUP}
    set found to false
    repeat with r in rows of o
      set t to (value of static text 1 of group 1 of UI element 1 of r)
      ignoring case
        if t is target then
          set selected of r to true
          set found to true
        else if selected of r then
          set selected of r to false
        end if
      end ignoring
    end repeat
    return found
  end tell
end run`,
    [keyword],
  );
  return out === "true";
}

export async function selectedRowCount(): Promise<number> {
  const out = await runOsa(`tell application "System Events" to tell process "${PROCESS_NAME}"
  set o to outline 1 of scroll area 1 of ${KEYWORD_GROUP}
  return count of (selected rows of o)
end tell`);
  return Number(out) || 0;
}

export async function clickAt(p: Point): Promise<void> {
  await runOsa(`tell application "System Events" to click at {${Math.round(p.x)}, ${Math.round(p.y)}}
delay 0.6`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
