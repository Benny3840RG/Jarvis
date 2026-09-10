import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The single directory every JSON-backed Jarvis store writes into. Historically
 * each `src/<domain>/json<Domain>Store.ts` computed
 * `path.resolve(dirname, "../../data/jarvis-<domain>.json")` independently; the
 * backup layer (archive v4) needs to open exactly those same files without going
 * through the stores, so the canonical location lives here.
 */
export const JARVIS_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data",
);

/** Absolute path of a `data/jarvis-*.json` document by its file basename. */
export function jarvisDataFile(basename: string): string {
  return path.join(JARVIS_DATA_DIR, basename);
}

/**
 * The core assistant-state document (state + tasks + reminders live together in
 * one file) and the five "memory store" documents already covered by archive v3.
 * Kept here so archive v4 can lock and strictly read them from one list; the
 * stores themselves still compute these paths identically.
 */
export const coreDataFiles = {
  state: jarvisDataFile("jarvis-state.json"),
  builds: jarvisDataFile("jarvis-builds.json"),
  buildLogs: jarvisDataFile("jarvis-build-logs.json"),
  upgrades: jarvisDataFile("jarvis-upgrades.json"),
  assets: jarvisDataFile("jarvis-assets.json"),
  preferences: jarvisDataFile("jarvis-preferences.json"),
} as const;

/**
 * The JSON-backed business record documents. Same shape as `coreDataFiles`: one
 * file per domain, each a `{ version, <collection> }` object, all written into
 * the same directory by `src/<domain>/json<Domain>Store.ts`.
 *
 * `businessSettings` is the odd one out — a single settings object rather than a
 * collection — and is listed here because archive v4 locks and reads it with the
 * rest of the group.
 */
export const businessDataFiles = {
  clients: jarvisDataFile("jarvis-clients.json"),
  properties: jarvisDataFile("jarvis-properties.json"),
  projects: jarvisDataFile("jarvis-projects.json"),
  quotes: jarvisDataFile("jarvis-quotes.json"),
  invoices: jarvisDataFile("jarvis-invoices.json"),
  enquiries: jarvisDataFile("jarvis-enquiries.json"),
  errands: jarvisDataFile("jarvis-errands.json"),
  businessSettings: jarvisDataFile("jarvis-business-settings.json"),
} as const;

export type BusinessDataKey = keyof typeof businessDataFiles;
