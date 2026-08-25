export interface Property {
  id: string;
  clientId: string;
  address: string;
  hazards: string[];
  accessNotes?: string;
  serviceNotes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PropertyInput {
  clientId: string;
  address: string;
  hazards?: string[];
  accessNotes?: string;
  serviceNotes?: string;
}

export interface PropertyUpdate {
  clientId?: string;
  address?: string;
  hazards?: string[];
  /** `string` sets notes, `null` clears them, `undefined` leaves them unchanged. */
  accessNotes?: string | null;
  /** `string` sets notes, `null` clears them, `undefined` leaves them unchanged. */
  serviceNotes?: string | null;
}

/** Durable store for client-owned service properties and site constraints. */
export interface PropertyStore {
  list(filter?: { clientId?: string }): Promise<Property[]>;
  get(id: string): Promise<Property | null>;
  add(input: PropertyInput): Promise<Property>;
  update(id: string, update: PropertyUpdate): Promise<Property | null>;
  remove(id: string): Promise<Property | null>;
}
