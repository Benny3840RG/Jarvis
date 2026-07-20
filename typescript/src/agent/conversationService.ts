import type { Payload } from "./types.js";

export interface ParsedInput {
  raw: string;
  intent: string;
  entities: Payload;
  context: Payload;
}

// Each canonical job intent maps from several natural phrasings. Order matters:
// the first phrase that appears in the text wins.
const INTENT_PHRASES: { intent: string; phrases: string[] }[] = [
  { intent: "start_job", phrases: ["start job", "kick off job", "begin job"] },
  { intent: "prepare_job", phrases: ["prepare job", "prep job", "set up job"] },
  { intent: "complete_job", phrases: ["complete job", "finish job", "close job"] },
];

export class ConversationService {
  parse(text: string, context: Payload = {}): ParsedInput {
    const lower = text.toLowerCase();

    for (const { intent, phrases } of INTENT_PHRASES) {
      for (const phrase of phrases) {
        if (!lower.includes(phrase)) continue;
        const entities: Payload = {};
        const match = new RegExp(`${phrase}\\s+(\\w+)`).exec(lower);
        if (match) entities.jobId = match[1];
        return { raw: text, intent, entities, context };
      }
    }

    return { raw: text, intent: "unknown", entities: {}, context };
  }
}
