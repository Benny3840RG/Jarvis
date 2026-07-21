/**
 * Builds: Benny's machines and projects worth remembering — the RC crawler, the
 * gull-wing trailer, a workshop tool, whatever he's building or running.
 *
 * This is the foundation domain: build logs (lore), the upgrade chronicle, and
 * maintenance records all attach to a build by id. A build is durable, stored
 * memory — Jarvis recalls it, it never invents one.
 */

export type BuildStatus = "planning" | "active" | "shelved" | "retired";

export const BUILD_STATUSES: readonly BuildStatus[] = ["planning", "active", "shelved", "retired"];

export interface Build {
  id: string;
  name: string;
  /** Freeform, e.g. "RC crawler", "trailer", "tool". */
  kind: string;
  status: BuildStatus;
  description?: string;
  nickname?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BuildInput {
  name: string;
  kind: string;
  status?: BuildStatus;
  description?: string;
  nickname?: string;
  notes?: string;
}

export interface BuildUpdate {
  name?: string;
  kind?: string;
  status?: BuildStatus;
  description?: string | null;
  nickname?: string | null;
  notes?: string | null;
}

export function isBuildStatus(value: unknown): value is BuildStatus {
  return typeof value === "string" && (BUILD_STATUSES as readonly string[]).includes(value);
}

/** Durable store for builds; a separate store like clients, projects, quotes, and errands. */
export interface BuildStore {
  list(): Promise<Build[]>;
  get(id: string): Promise<Build | null>;
  add(input: BuildInput): Promise<Build>;
  update(id: string, update: BuildUpdate): Promise<Build | null>;
  remove(id: string): Promise<Build | null>;
}
