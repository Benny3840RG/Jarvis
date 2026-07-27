import type { ReminderDue } from "../reminders/due.js";
import type { ReminderUpdate, TaskUpdate } from "./updates.js";

export type { ReminderDue, ReminderUpdate, TaskUpdate };

export type AssistantState = {
  lastIntent?: string;
  lastInput?: string;
  lastResult?: unknown;
  lastReminder?: unknown;
  lastTask?: unknown;
  [key: string]: unknown;
};

export type Task = {
  id: string;
  title: string;
  completed: boolean;
  category: string;
  createdAt: number;
};

export type Reminder = {
  id: string;
  title: string;
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
  createdAt: number;
};

export type CreateRequestIdentity = {
  idempotencyKey: string;
  requestFingerprint: string;
};

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

export interface PersistenceProvider {
  loadState(): Promise<AssistantState>;
  saveState(state: AssistantState): Promise<void>;
  listTasks(): Promise<Task[]>;
  addTask(title: string, category: string, identity?: CreateRequestIdentity): Promise<Task>;
  updateTask(id: string, update: TaskUpdate): Promise<Task | null>;
  completeTask(id: string): Promise<Task | null>;
  removeTask(id: string): Promise<Task | null>;
  listReminders(): Promise<Reminder[]>;
  addReminder(
    title: string,
    due?: ReminderDue,
    identity?: CreateRequestIdentity,
  ): Promise<Reminder>;
  updateReminder(id: string, update: ReminderUpdate): Promise<Reminder | null>;
  removeReminder(id: string): Promise<Reminder | null>;
  snapshot?(): Promise<PersistenceSnapshot>;
  restoreSnapshotIntoEmpty?(snapshot: PersistenceSnapshot): Promise<PersistenceRestoreResult>;
}

export type PersistenceWarning = (message: string) => void;
