/**
 * Errands: pick-up-on-the-way items like "we need milk" or "silicone x2 at
 * Bunnings for the deck job".
 *
 * Locations are structured but optional. Geocoding happens at the conversation
 * layer — the assistant resolves a place (e.g. via its maps tooling) and passes
 * the structured result in — so the server only stores locations and never
 * calls a maps provider itself. There is no GPS geofencing here: surfacing an
 * errand "when you're at the shop" is a conversational pull ("I'm at Bunnings,
 * what do I need?"), not a phone-triggered alert.
 */

export type ErrandStatus = "open" | "done";

export const ERRAND_STATUSES: readonly ErrandStatus[] = ["open", "done"];

export interface ErrandLocation {
  /** Human place name, e.g. "Bunnings Frankston". Always required. */
  label: string;
  address?: string;
  lat?: number;
  lon?: number;
}

export interface Errand {
  id: string;
  title: string;
  quantity?: number;
  status: ErrandStatus;
  location?: ErrandLocation;
  projectId?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ErrandInput {
  title: string;
  quantity?: number;
  status?: ErrandStatus;
  location?: ErrandLocation;
  projectId?: string;
  notes?: string;
}

export interface ErrandUpdate {
  title?: string;
  quantity?: number | null;
  status?: ErrandStatus;
  location?: ErrandLocation | null;
  projectId?: string | null;
  notes?: string | null;
}

export function isErrandStatus(value: unknown): value is ErrandStatus {
  return typeof value === "string" && (ERRAND_STATUSES as readonly string[]).includes(value);
}

/** Durable store for errands; a separate store like clients, projects, and quotes. */
export interface ErrandStore {
  list(): Promise<Errand[]>;
  get(id: string): Promise<Errand | null>;
  add(input: ErrandInput): Promise<Errand>;
  update(id: string, update: ErrandUpdate): Promise<Errand | null>;
  remove(id: string): Promise<Errand | null>;
}
