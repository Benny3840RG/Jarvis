export interface ClientContact {
  label?: string;
  value: string;
}

export interface Client {
  id: string;
  name: string;
  contacts: ClientContact[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ClientInput {
  name: string;
  contacts?: ClientContact[];
  notes?: string;
}

export interface ClientUpdate {
  name?: string;
  contacts?: ClientContact[];
  /** `string` sets notes, `null` clears them, `undefined` leaves them unchanged. */
  notes?: string | null;
}

/**
 * Durable store for business clients. A separate store (like tool actions and
 * memory change sets) rather than an extension of the core task/reminder
 * PersistenceProvider, so it adds no new required methods to existing mocks.
 */
export interface ClientStore {
  list(): Promise<Client[]>;
  get(id: string): Promise<Client | null>;
  add(input: ClientInput): Promise<Client>;
  update(id: string, update: ClientUpdate): Promise<Client | null>;
  remove(id: string): Promise<Client | null>;
}
