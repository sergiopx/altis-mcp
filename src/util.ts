/** Shared helpers for tool handlers. */
import { AltisStore } from "./db.js";

/** Open the store lazily per call so the server still starts if Altis is absent. */
export function withStore<T>(fn: (s: AltisStore) => T): T {
  const store = new AltisStore();
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

export function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
