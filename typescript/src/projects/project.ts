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
  propertyId?: string;
  title: string;
  status: ProjectStatus;
  notes?: string;
  /** The day the job is booked for, as an ISO `YYYY-MM-DD` date. Optional. */
  scheduledFor?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectInput {
  clientId: string;
  propertyId?: string;
  title: string;
  status?: ProjectStatus;
  notes?: string;
  scheduledFor?: string;
}

export interface ProjectUpdate {
  clientId?: string;
  /** `string` sets the property link, `null` clears it, `undefined` leaves it unchanged. */
  propertyId?: string | null;
  title?: string;
  status?: ProjectStatus;
  /** `string` sets notes, `null` clears them, `undefined` leaves them unchanged. */
  notes?: string | null;
  /** `string` sets the scheduled date, `null` clears it, `undefined` leaves it unchanged. */
  scheduledFor?: string | null;
}

/** Durable store for business projects (jobs), a separate store like clients. */
export interface ProjectStore {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  add(input: ProjectInput): Promise<Project>;
  update(id: string, update: ProjectUpdate): Promise<Project | null>;
  remove(id: string): Promise<Project | null>;
}

export function parseProjectScheduledDate(value: unknown): string {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value.trim())) {
    throw new Error("Project scheduledFor must be an ISO date (YYYY-MM-DD).");
  }
  const text = value.trim();
  const [year, month, day] = text.split("-").map(Number);
  if (year < 1) throw new Error("Project scheduledFor is not a valid calendar date.");
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Project scheduledFor is not a valid calendar date.");
  }
  return text;
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}
