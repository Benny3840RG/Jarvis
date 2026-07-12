export type Intent = "greeting" | "planning" | "memory" | "general";

export type ParsedConversation = {
  text: string;
  intent: Intent;
  entities: Record<string, never>;
  context: Record<string, unknown>;
};

export class ConversationService {
  parse(message: string, context: Record<string, unknown> = {}): ParsedConversation {
    const lower = message.toLowerCase();
    let intent: Intent = "general";
    if (lower.includes("hello") || lower.includes("hi") || lower.includes("hey")) {
      intent = "greeting";
    } else if (lower.includes("plan")) {
      intent = "planning";
    } else if (lower.includes("remember")) {
      intent = "memory";
    }
    return { text: message, intent, entities: {}, context };
  }
}
