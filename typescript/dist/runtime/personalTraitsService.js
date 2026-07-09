export class PersonalTraitsService {
    notes = [];
    dailyBrief() {
        return "Today: prioritise what matters, protect your energy, and stay organised.";
    }
    motivation() {
        return "You’ve got a calm, capable day ahead. Keep moving one step at a time.";
    }
    addNote(title) {
        const note = { title, createdAt: new Date().toISOString() };
        this.notes.push(note);
        return note;
    }
    priorityRank(items) {
        return items.map((item, index) => ({ item, score: items.length - index }));
    }
}
