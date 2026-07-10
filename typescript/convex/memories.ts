import type { ConvexClient } from "convex";
import type { MemoryRow } from "./schema";

export const MEMORY_CREATE_FN = "memories/create";
export const MEMORY_LIST_FN = "memories/list";
export const MEMORY_UPDATE_FN = "memories/update";
export const MEMORY_DELETE_FN = "memories/delete";

export async function createMemory(client: ConvexClient | any, memory: MemoryRow) {
  return client.mutation(MEMORY_CREATE_FN, memory);
}

export async function listMemories(client: ConvexClient | any) {
  return client.query(MEMORY_LIST_FN);
}

export async function updateMemory(client: ConvexClient | any, id: string, patch: Partial<MemoryRow>) {
  return client.mutation(MEMORY_UPDATE_FN, { id, patch });
}

export async function deleteMemory(client: ConvexClient | any, id: string) {
  return client.mutation(MEMORY_DELETE_FN, { id });
}
