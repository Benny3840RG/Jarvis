import { applyErrandUpdate, cloneErrand, createErrand } from "./errandData.js";
import type { Errand, ErrandInput, ErrandStore, ErrandUpdate } from "./errand.js";

/** In-memory ErrandStore for tests and default HTTP wiring; nothing is persisted. */
export class InMemoryErrandStore implements ErrandStore {
  private readonly errands = new Map<string, Errand>();

  list(): Promise<Errand[]> {
    return Promise.resolve([...this.errands.values()].map(cloneErrand));
  }

  get(id: string): Promise<Errand | null> {
    const errand = this.errands.get(id);
    return Promise.resolve(errand ? cloneErrand(errand) : null);
  }

  add(input: ErrandInput): Promise<Errand> {
    let errand: Errand;
    try {
      errand = createErrand(input);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.errands.set(errand.id, errand);
    return Promise.resolve(cloneErrand(errand));
  }

  update(id: string, update: ErrandUpdate): Promise<Errand | null> {
    const errand = this.errands.get(id);
    if (!errand) return Promise.resolve(null);
    try {
      applyErrandUpdate(errand, update);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(cloneErrand(errand));
  }

  remove(id: string): Promise<Errand | null> {
    const errand = this.errands.get(id);
    if (!errand) return Promise.resolve(null);
    this.errands.delete(id);
    return Promise.resolve(cloneErrand(errand));
  }
}
