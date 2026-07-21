import { applyUpgradeUpdate, cloneUpgrade, createUpgrade } from "./upgradeData.js";
import type { Upgrade, UpgradeInput, UpgradeStore, UpgradeUpdate } from "./upgrade.js";

/** In-memory UpgradeStore for tests and default HTTP wiring; nothing is persisted. */
export class InMemoryUpgradeStore implements UpgradeStore {
  private readonly entries = new Map<string, Upgrade>();

  list(): Promise<Upgrade[]> {
    return Promise.resolve([...this.entries.values()].map(cloneUpgrade));
  }

  get(id: string): Promise<Upgrade | null> {
    const entry = this.entries.get(id);
    return Promise.resolve(entry ? cloneUpgrade(entry) : null);
  }

  add(input: UpgradeInput): Promise<Upgrade> {
    let entry: Upgrade;
    try {
      entry = createUpgrade(input);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.entries.set(entry.id, entry);
    return Promise.resolve(cloneUpgrade(entry));
  }

  update(id: string, update: UpgradeUpdate): Promise<Upgrade | null> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(null);
    try {
      applyUpgradeUpdate(entry, update);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(cloneUpgrade(entry));
  }

  remove(id: string): Promise<Upgrade | null> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(null);
    this.entries.delete(id);
    return Promise.resolve(cloneUpgrade(entry));
  }
}
