export class PersonalTraitsService {
  private readonly notes: Array<{ title: string; createdAt: string }> = [];

  dailyBrief(): string {
    return "Today: prioritise what matters, protect your energy, and stay organised.";
  }

  motivation(): string {
    return "You’ve got a calm, capable day ahead. Keep moving one step at a time.";
  }

  addNote(title: string) {
    const note = { title, createdAt: new Date().toISOString() };
    this.notes.push(note);
    return note;
  }

  priorityRank(items: string[]) {
    return items.map((item, index) => ({ item, score: items.length - index }));
  }
}
