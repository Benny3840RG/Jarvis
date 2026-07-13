import type { ConvexClientLike } from "./persistenceCore.js";

export {
  assistantStateFunctions,
  normalizeDocument,
  reminderFunctions,
  taskFunctions,
} from "./persistenceCore.js";
export type {
  AssistantState,
  ConvexClientLike,
  PersistenceWarning,
  Reminder,
  ReminderDue,
  ReminderUpdate,
  Task,
  TaskUpdate,
} from "./persistenceCore.js";
export type {
  PersistenceProvider,
  PersistenceRestoreResult,
  PersistenceSnapshot,
} from "./atomicTypes.js";
export { JSONPersistence } from "./atomicJson.js";
export { ConvexPersistence } from "./atomicConvex.js";

import { JSONPersistence } from "./atomicJson.js";
import { ConvexPersistence } from "./atomicConvex.js";
import type { PersistenceProvider } from "./atomicTypes.js";

export function createPersistenceFromEnv(client?: ConvexClientLike): PersistenceProvider {
  const provider = (process.env.PERSISTENCE_PROVIDER ?? "json").trim().toLowerCase();
  if (provider === "" || provider === "json") return new JSONPersistence();
  if (provider === "convex") return new ConvexPersistence(client);
  throw new Error(
    `Invalid PERSISTENCE_PROVIDER '${process.env.PERSISTENCE_PROVIDER}'. Valid values: unset, json, convex.`,
  );
}
