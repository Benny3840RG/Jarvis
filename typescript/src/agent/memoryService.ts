export class MemoryService {
  private readonly store = new Map<string, unknown>();

  read(key: string): unknown {
    return this.store.get(key);
  }

  write(key: string, value: unknown): void {
    this.store.set(key, value);
  }
}
