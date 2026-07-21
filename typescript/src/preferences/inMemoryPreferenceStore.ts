import { applyPreferenceUpdate, clonePreference, createPreference } from "./preferenceData.js";
import type {
  Preference,
  PreferenceInput,
  PreferenceStore,
  PreferenceUpdate,
} from "./preference.js";

/** In-memory PreferenceStore for tests and default HTTP wiring; nothing is persisted. */
export class InMemoryPreferenceStore implements PreferenceStore {
  private readonly entries = new Map<string, Preference>();

  list(): Promise<Preference[]> {
    return Promise.resolve([...this.entries.values()].map(clonePreference));
  }

  get(id: string): Promise<Preference | null> {
    const entry = this.entries.get(id);
    return Promise.resolve(entry ? clonePreference(entry) : null);
  }

  add(input: PreferenceInput): Promise<Preference> {
    let entry: Preference;
    try {
      entry = createPreference(input);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.entries.set(entry.id, entry);
    return Promise.resolve(clonePreference(entry));
  }

  update(id: string, update: PreferenceUpdate): Promise<Preference | null> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(null);
    try {
      applyPreferenceUpdate(entry, update);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(clonePreference(entry));
  }

  remove(id: string): Promise<Preference | null> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(null);
    this.entries.delete(id);
    return Promise.resolve(clonePreference(entry));
  }
}
