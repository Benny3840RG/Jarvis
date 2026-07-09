export class MemoryService {
    store = new Map();
    write(key, value) {
        this.store.set(key, value);
    }
    read(key) {
        return this.store.get(key) ?? null;
    }
    snapshot() {
        return Object.fromEntries(this.store.entries());
    }
}
