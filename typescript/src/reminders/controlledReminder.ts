import type { InternalActionContext } from "../tasks/controlledTask.js";

export type ControlledReminderRecord = {
  id: string;
  projectId: string;
  title: string;
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  cancelledAt?: number;
};

export type CreateControlledReminderInput = InternalActionContext & {
  title: string;
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
};

export type CancelControlledReminderInput = InternalActionContext & {
  reminderId: string;
};

export interface ControlledReminderStore {
  create(input: CreateControlledReminderInput): Promise<ControlledReminderRecord>;
  cancel(input: CancelControlledReminderInput): Promise<ControlledReminderRecord | null>;
  get(projectId: string, reminderId: string): Promise<ControlledReminderRecord | null>;
  cleanup(projectId: string, reminderId: string): Promise<boolean>;
}
