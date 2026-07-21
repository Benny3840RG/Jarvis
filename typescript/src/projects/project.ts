export type ProjectStatus = "lead" | "quoted" | "active" | "on_hold" | "done";

export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  "lead",
  "quoted",
  "active",
  "on_hold",
  "done",
];

export interface Project {
  id: string;
  clientId: string;
  title: string;
  status: ProjectStatus;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectInput {
  clientId: string;
  title: string;
  status?: ProjectStatus;
  notes?: string;
}

export interface ProjectUpdate {
  clientId?: string;
  title?: string;
  status?: ProjectStatus;
  /** `string` sets notes, `null` clears them, `undefined` leaves them unchanged. */
  notes?: string | null;
}

/** Durable store for business projects (jobs), a separate store like clients. */
export interface ProjectStore {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  add(input: ProjectInput): Promise<Project>;
  update(id: string, update: ProjectUpdate): Promise<Project | null>;
  remove(id: string): Promise<Project | null>;
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}
