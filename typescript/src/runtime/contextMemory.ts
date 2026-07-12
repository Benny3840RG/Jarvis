export class ContextMemory {
  private readonly entries: string[] = [];

  remember(text: string): void {
    this.entries.push(text.toLowerCase());
  }

  recall(keyword: string): string[] {
    return this.entries.filter((entry) => entry.includes(keyword.toLowerCase()));
  }
}
