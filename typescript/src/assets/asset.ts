/**
 * Assets & Maintenance: the tools, machines, and kit Benny wants to keep on top
 * of servicing. Each asset can carry a service interval and a last-serviced
 * date; from those two the read layer derives when the next service is due and
 * whether it's overdue (see deriveAssetView in the HTTP layer).
 *
 * The store persists only what was entered — it computes nothing. Durable,
 * stored memory: Jarvis recalls the service history it was told, and reasons
 * over it. It is not a live scheduler and sends no notifications.
 */

export interface Asset {
  id: string;
  name: string;
  kind: string;
  /** How often this asset should be serviced, in whole days. */
  serviceIntervalDays?: number;
  /** When it was last serviced (ms epoch). */
  lastServicedAt?: number;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AssetInput {
  name: string;
  kind: string;
  serviceIntervalDays?: number;
  lastServicedAt?: number;
  notes?: string;
}

export interface AssetUpdate {
  name?: string;
  kind?: string;
  serviceIntervalDays?: number | null;
  lastServicedAt?: number | null;
  notes?: string | null;
}

/** Durable store for assets; a separate store like the other domains. */
export interface AssetStore {
  list(): Promise<Asset[]>;
  get(id: string): Promise<Asset | null>;
  add(input: AssetInput): Promise<Asset>;
  update(id: string, update: AssetUpdate): Promise<Asset | null>;
  remove(id: string): Promise<Asset | null>;
}
