import type { Reminder } from "../persistence/persistence.js";

export type { Reminder };

export class ReminderService {
  private reminders: Reminder[];

  constructor(initial: Reminder[] = []) {
    this.reminders = initial.map((reminder) => ({ ...reminder }));
  }

  replace(reminders: Reminder[]): void {
    this.reminders = reminders.map((reminder) => ({ ...reminder }));
  }

  list(): Reminder[] {
    return this.reminders.map((reminder) => ({ ...reminder }));
  }
}
