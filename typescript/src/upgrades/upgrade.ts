/**
 * Upgrade Chronicle: the record of changes made to a build over its life. Each
 * upgrade links to a build by id (see the builds domain) and captures what was
 * changed, why, the state before and after, how it turned out, the parts
 * involved, an optional version label, and when it happened.
 *
 * Durable, stored memory: Jarvis recalls the chronicle, it never invents it.
 */

export interface Upgrade {
  id: string;
  /** The build this upgrade belongs to (builds domain id). */
  buildId: string;
  title: string;
  /** Why the change was made. */
  reason?: string;
  /** How the build was before the change. */
  beforeState?: string;
  /** How the build is after the change. */
  afterState?: string;
  /** How it turned out in use. */
  outcome?: string;
  /** Parts swapped in or involved in the change. */
  parts?: string[];
  /** An optional version label for this state of the build (e.g. "v3"). */
  version?: string;
  /** When the change was made, if known (ms epoch); distinct from createdAt. */
  occurredAt?: number;
  createdAt: number;
  /**
   * Optional because existing rows predate this field (Convex requires
   * widening a schema with an optional field before any backfill migration).
   * Always present on entries created or updated after this field's addition.
   */
  updatedAt?: number;
}

export interface UpgradeInput {
  buildId: string;
  title: string;
  reason?: string;
  beforeState?: string;
  afterState?: string;
  outcome?: string;
  parts?: string[];
  version?: string;
  occurredAt?: number;
}

export interface UpgradeUpdate {
  buildId?: string;
  title?: string;
  reason?: string | null;
  beforeState?: string | null;
  afterState?: string | null;
  outcome?: string | null;
  parts?: string[] | null;
  version?: string | null;
  occurredAt?: number | null;
}

/** Durable store for upgrade-chronicle entries; a separate store like the other domains. */
export interface UpgradeStore {
  list(): Promise<Upgrade[]>;
  get(id: string): Promise<Upgrade | null>;
  add(input: UpgradeInput): Promise<Upgrade>;
  update(id: string, update: UpgradeUpdate): Promise<Upgrade | null>;
  remove(id: string): Promise<Upgrade | null>;
}
