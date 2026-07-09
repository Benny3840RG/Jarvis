export class DomainRegistry {
    services = new Map();
    register(name, handler) {
        this.services.set(name, handler);
    }
    resolve(name) {
        return this.services.get(name);
    }
}
