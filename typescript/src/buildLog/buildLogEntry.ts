/**
 * Build log: the lore. Dated entries attached to a build — why it started, the
 * milestones, the failures, the anecdotes, the loose notes. Jarvis reads them
 * back in order to tell the story of a build.
 *
 * Each entry links to a build by id (see the builds domain). Durable, stored
 * memory: Jarvis recalls the log, it never invents it.
 */

export type BuildLogKind = "origin" | "milestone" | "failure" | "anecdote" | "note";

export const BUILD_LOG_KINDS: readonly BuildLogKind[] = [
  "origin",
  "milestone",
  "failure",
  "anecdote",
  "note",
];

export interface BuildLogEntry {
  id: string;
  /** The build this entry belongs to (builds domain id). */
  buildId: string;
  kind: BuildLogKind;
  title: string;
  body?: string;
  /** When it actually happened, if known (ms epoch); distinct from createdAt. */
  occurredAt?: number;
  createdAt: number;
}

export interface BuildLogInput {
  buildId: string;
  kind?: BuildLogKind;
  title: string;
  body?: string;
  occurredAt?: number;
}

export interface BuildLogUpdate {
  buildId?: string;
  kind?: BuildLogKind;
  title?: string;
  body?: string | null;
  occurredAt?: number | null;
}

export function isBuildLogKind(value: unknown): value is BuildLogKind {
  return typeof value === "string" && (BUILD_LOG_KINDS as readonly string[]).includes(value);
}

/** Durable store for build-log entries; a separate store like the other domains. */
export interface BuildLogStore {
  list(): Promise<BuildLogEntry[]>;
  get(id: string): Promise<BuildLogEntry | null>;
  add(input: BuildLogInput): Promise<BuildLogEntry>;
  update(id: string, update: BuildLogUpdate): Promise<BuildLogEntry | null>;
  remove(id: string): Promise<BuildLogEntry | null>;
}
