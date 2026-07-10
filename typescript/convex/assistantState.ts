import type { ConvexClient } from "convex";
import type { AssistantStateRow } from "./schema";

export const ASSISTANT_STATE_GET_FN = "assistantState/get";
export const ASSISTANT_STATE_UPSERT_FN = "assistantState/upsert";

export async function getAssistantState(client: ConvexClient | any) {
  return client.query(ASSISTANT_STATE_GET_FN);
}

export async function upsertAssistantState(client: ConvexClient | any, state: Record<string, unknown>) {
  return client.mutation(ASSISTANT_STATE_UPSERT_FN, state);
}
