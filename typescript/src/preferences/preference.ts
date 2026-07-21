/**
 * Preferences: the settings and standing choices Jarvis keeps for Benny — his
 * brands, tools, naming conventions, defaults, the way he likes things done.
 * Each is a key/value pair with an optional category to group related ones.
 *
 * Durable, stored memory: Jarvis recalls what it was told, it never invents a
 * preference. Keys are not required to be unique — the same key can hold a
 * history of values if Benny keeps more than one.
 */

export interface Preference {
  id: string;
  key: string;
  value: string;
  /** An optional grouping label (e.g. "paint", "hardware", "naming"). */
  category?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PreferenceInput {
  key: string;
  value: string;
  category?: string;
}

export interface PreferenceUpdate {
  key?: string;
  value?: string;
  category?: string | null;
}

/** Durable store for preferences; a separate store like the other domains. */
export interface PreferenceStore {
  list(): Promise<Preference[]>;
  get(id: string): Promise<Preference | null>;
  add(input: PreferenceInput): Promise<Preference>;
  update(id: string, update: PreferenceUpdate): Promise<Preference | null>;
  remove(id: string): Promise<Preference | null>;
}
