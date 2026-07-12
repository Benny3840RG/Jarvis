export type Reminder = { id: string; title: string; due?: string };

export class ReminderService {
  private reminders: Reminder[] = [];

  add(title: string, due?: string): Reminder {
    const reminder = { id: `${Date.now()}`, title, due };
    this.reminders.push(reminder);
    return reminder;
  }

  list(): Reminder[] {
    return [...this.reminders];
  }

  clear(): void {
    this.reminders = [];
  }
}
