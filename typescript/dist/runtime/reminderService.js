export class ReminderService {
    reminders = [];
    add(title, due) {
        const reminder = { id: `${Date.now()}`, title, due };
        this.reminders.push(reminder);
        return reminder;
    }
    list() {
        return [...this.reminders];
    }
    clear() {
        this.reminders = [];
    }
}
