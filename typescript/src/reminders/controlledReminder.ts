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

export type RescheduleControlledReminderInput = InternalActionContext & {
  reminderId: string;
  dueRaw: string;
  dueAt?: number;
  dueTimezone?: string;
};

export interface ControlledReminderStore {
  create(input: CreateControlledReminderInput): Promise<ControlledReminderRecord>;
  cancel(input: CancelControlledReminderInput): Promise<ControlledReminderRecord | null>;
  /**
   * AM-017 (planned): replace one reminder's due value. Optional so stores
   * that predate it stay valid; the reschedule executor is only registered
   * when the store provides it and AM-017 is explicitly enabled.
   */
  reschedule?(input: RescheduleControlledReminderInput): Promise<ControlledReminderRecord | null>;
  get(projectId: string, reminderId: string): Promise<ControlledReminderRecord | null>;
  cleanup(projectId: string, reminderId: string): Promise<boolean>;
}
