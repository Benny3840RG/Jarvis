export type Reminder = { id: string; title: string; due?: string };

export class ReminderService {
  private reminders: Reminder[];

  constructor(initial: Reminder[] = []) {
    this.reminders = initial.map((reminder) => ({ ...reminder }));
  }

  add(title: string, due?: string): Reminder {
    const reminder = { id: `${Date.now()}`, title, due };
    this.reminders.push(reminder);
    return reminder;
  }

  remember(reminder: Reminder): Reminder {
    const existing = this.reminders.find((entry) => entry.id === reminder.id);
    if (existing) {
      Object.assign(existing, reminder);
      return { ...existing };
    }
    this.reminders.push({ ...reminder });
    return { ...reminder };
  }

  list(): Reminder[] {
    return this.reminders.map((reminder) => ({ ...reminder }));
  }

  remove(id: string): boolean {
    const next = this.reminders.filter((entry) => entry.id !== id);
    if (next.length === this.reminders.length) return false;
    this.reminders = next;
    return true;
  }

  clear(): void {
    this.reminders = [];
  }
}
