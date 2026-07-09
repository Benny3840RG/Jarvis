export class ContextMemory {
    entries = [];
    remember(text) {
        this.entries.push(text.toLowerCase());
    }
    recall(keyword) {
        return this.entries.filter((entry) => entry.includes(keyword.toLowerCase()));
    }
}
