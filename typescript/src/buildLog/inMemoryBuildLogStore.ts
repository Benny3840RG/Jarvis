import { applyBuildLogUpdate, cloneBuildLogEntry, createBuildLogEntry } from "./buildLogData.js";
import type {
  BuildLogEntry,
  BuildLogInput,
  BuildLogStore,
  BuildLogUpdate,
} from "./buildLogEntry.js";

/** In-memory BuildLogStore for tests and default HTTP wiring; nothing is persisted. */
export class InMemoryBuildLogStore implements BuildLogStore {
  private readonly entries = new Map<string, BuildLogEntry>();

  list(): Promise<BuildLogEntry[]> {
    return Promise.resolve([...this.entries.values()].map(cloneBuildLogEntry));
  }

  get(id: string): Promise<BuildLogEntry | null> {
    const entry = this.entries.get(id);
    return Promise.resolve(entry ? cloneBuildLogEntry(entry) : null);
  }

  add(input: BuildLogInput): Promise<BuildLogEntry> {
    let entry: BuildLogEntry;
    try {
      entry = createBuildLogEntry(input);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.entries.set(entry.id, entry);
    return Promise.resolve(cloneBuildLogEntry(entry));
  }

  update(id: string, update: BuildLogUpdate): Promise<BuildLogEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(null);
    try {
      applyBuildLogUpdate(entry, update);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(cloneBuildLogEntry(entry));
  }

  remove(id: string): Promise<BuildLogEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(null);
    this.entries.delete(id);
    return Promise.resolve(cloneBuildLogEntry(entry));
  }
}
