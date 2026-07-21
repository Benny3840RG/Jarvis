import { applyAssetUpdate, cloneAsset, createAsset } from "./assetData.js";
import type { Asset, AssetInput, AssetStore, AssetUpdate } from "./asset.js";

/** In-memory AssetStore for tests and default HTTP wiring; nothing is persisted. */
export class InMemoryAssetStore implements AssetStore {
  private readonly entries = new Map<string, Asset>();

  list(): Promise<Asset[]> {
    return Promise.resolve([...this.entries.values()].map(cloneAsset));
  }

  get(id: string): Promise<Asset | null> {
    const entry = this.entries.get(id);
    return Promise.resolve(entry ? cloneAsset(entry) : null);
  }

  add(input: AssetInput): Promise<Asset> {
    let entry: Asset;
    try {
      entry = createAsset(input);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.entries.set(entry.id, entry);
    return Promise.resolve(cloneAsset(entry));
  }

  update(id: string, update: AssetUpdate): Promise<Asset | null> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(null);
    try {
      applyAssetUpdate(entry, update);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(cloneAsset(entry));
  }

  remove(id: string): Promise<Asset | null> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(null);
    this.entries.delete(id);
    return Promise.resolve(cloneAsset(entry));
  }
}
