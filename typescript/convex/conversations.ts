import type { ConvexClient } from "convex";
import type { ConversationRow } from "./schema";

export const CONVERSATION_CREATE_FN = "conversations/create";
export const CONVERSATION_LIST_FN = "conversations/list";
export const CONVERSATION_UPDATE_FN = "conversations/update";
export const CONVERSATION_DELETE_FN = "conversations/delete";

export async function createConversation(client: ConvexClient | any, conversation: ConversationRow) {
  return client.mutation(CONVERSATION_CREATE_FN, conversation);
}

export async function listConversations(client: ConvexClient | any) {
  return client.query(CONVERSATION_LIST_FN);
}

export async function updateConversation(client: ConvexClient | any, id: string, patch: Partial<ConversationRow>) {
  return client.mutation(CONVERSATION_UPDATE_FN, { id, patch });
}

export async function deleteConversation(client: ConvexClient | any, id: string) {
  return client.mutation(CONVERSATION_DELETE_FN, { id });
}
