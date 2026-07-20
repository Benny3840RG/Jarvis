import type { InteractionRecord } from "./learningEngine.js";

export class PredictionEngine {
  predictNextIntent(history: InteractionRecord[]): string | null {
    if (history.length === 0) return null;
    const last = history[history.length - 1];

    if (last.intent === "start_job") return "prepare_job";
    if (last.intent === "prepare_job") return "complete_job";

    return null;
  }
}
