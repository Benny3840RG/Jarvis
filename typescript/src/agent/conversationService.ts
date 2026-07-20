import type { Payload } from "./types.js";

export interface ParsedInput {
  raw: string;
  intent: string;
  entities: Payload;
  context: Payload;
}

export class ConversationService {
  parse(text: string, context: Payload = {}): ParsedInput {
    const lower = text.toLowerCase();

    let intent = "unknown";
    const entities: Payload = {};

    const jobIntents: { keyword: string; intent: string }[] = [
      { keyword: "start job", intent: "start_job" },
      { keyword: "complete job", intent: "complete_job" },
      { keyword: "prepare job", intent: "prepare_job" },
    ];

    for (const candidate of jobIntents) {
      if (lower.includes(candidate.keyword)) {
        intent = candidate.intent;
        const match = new RegExp(`${candidate.keyword}\\s+(\\w+)`).exec(lower);
        if (match) entities.jobId = match[1];
        break;
      }
    }

    return { raw: text, intent, entities, context };
  }
}
