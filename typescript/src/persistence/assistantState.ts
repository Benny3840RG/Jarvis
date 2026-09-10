import type { AssistantState } from "./types.js";

export function assertAssistantState(value: unknown): asserts value is AssistantState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Assistant state must be an object.");
  }
  const ancestors = new WeakSet<object>();
  function visit(entry: unknown): void {
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new Error("Assistant state numbers must be finite.");
    }
    if (typeof entry !== "object" || entry === null) return;
    if (ancestors.has(entry)) {
      throw new Error("Assistant state must not contain circular references.");
    }
    ancestors.add(entry);
    for (const child of Object.values(entry)) visit(child);
    ancestors.delete(entry);
  }
  visit(value);
}
