import type { AssistantState } from "./types.js";

export function assertAssistantState(value: unknown): asserts value is AssistantState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Assistant state must be an object.");
  }
}
