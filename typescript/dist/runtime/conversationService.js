export class ConversationService {
    parse(message, context = {}) {
        const lower = message.toLowerCase();
        let intent = "general";
        if (lower.includes("hello") || lower.includes("hi") || lower.includes("hey")) {
            intent = "greeting";
        }
        else if (lower.includes("plan")) {
            intent = "planning";
        }
        else if (lower.includes("remember")) {
            intent = "memory";
        }
        return {
            text: message,
            intent,
            entities: {},
            context,
        };
    }
}
