export class IntentRouter {
    route(text) {
        const lower = text.toLowerCase();
        if (lower.includes("hello") || lower.includes("hi") || lower.includes("hey")) {
            return "greeting";
        }
        if (lower.includes("plan") || lower.includes("schedule") || lower.includes("task")) {
            return "planning";
        }
        if (lower.includes("remember") || lower.includes("my name")) {
            return "memory";
        }
        return "general";
    }
}
