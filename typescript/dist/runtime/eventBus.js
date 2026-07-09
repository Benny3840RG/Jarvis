export class EventBus {
    handlers = new Map();
    subscribe(type, handler) {
        const list = this.handlers.get(type) ?? [];
        list.push(handler);
        this.handlers.set(type, list);
    }
    async publish(event) {
        const list = this.handlers.get(event.type) ?? [];
        for (const handler of list) {
            await handler(event);
        }
    }
}
