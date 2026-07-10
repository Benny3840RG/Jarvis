import type { ConvexClient } from "convex";
import type { TaskRow } from "./schema";

export const TASK_CREATE_FN = "tasks/create";
export const TASK_LIST_FN = "tasks/list";
export const TASK_UPDATE_FN = "tasks/update";
export const TASK_DELETE_FN = "tasks/delete";

export async function createTask(client: ConvexClient | any, task: TaskRow) {
  return client.mutation(TASK_CREATE_FN, task);
}

export async function listTasks(client: ConvexClient | any) {
  return client.query(TASK_LIST_FN);
}

export async function updateTask(client: ConvexClient | any, id: string, patch: Partial<TaskRow>) {
  return client.mutation(TASK_UPDATE_FN, { id, patch });
}

export async function deleteTask(client: ConvexClient | any, id: string) {
  return client.mutation(TASK_DELETE_FN, { id });
}
