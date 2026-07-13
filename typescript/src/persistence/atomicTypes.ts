import type {
  AssistantState,
  PersistenceProvider as CorePersistenceProvider,
  Reminder,
  Task,
} from "./persistenceCore.js";

export type PersistenceSnapshot = {
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
};

export type PersistenceRestoreResult = {
  snapshot: PersistenceSnapshot;
  taskIds: ReadonlyMap<string, string>;
  reminderIds: ReadonlyMap<string, string>;
};

export interface PersistenceProvider extends CorePersistenceProvider {
  snapshot?(): Promise<PersistenceSnapshot>;
  restoreSnapshotIntoEmpty?(snapshot: PersistenceSnapshot): Promise<PersistenceRestoreResult>;
}
