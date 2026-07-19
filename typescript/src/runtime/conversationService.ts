import { classifyIntent } from "./intentClassifier.js";

export type Intent = "greeting" | "planning" | "memory" | "general";

export type ParsedConversation = {
  text: string;
  intent: Intent;
  entities: Record<string, never>;
  context: Record<string, unknown>;
};

export class ConversationService {
  parse(message: string, context: Record<string, unknown> = {}): ParsedConversation {
    return { text: message, intent: classifyIntent(message), entities: {}, context };
  }
}
