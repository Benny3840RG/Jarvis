export class MemoryService {
  private readonly store = new Map<string, unknown>();

  write(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  read(key: string): unknown | null {
    return this.store.get(key) ?? null;
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.store.entries());
  }
}
