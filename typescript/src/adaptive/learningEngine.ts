export class LearningEngine {
  private readonly history: string[] = [];

  observe(event: string): void {
    this.history.push(event.toLowerCase());
  }

  suggest(): string {
    if (this.history.includes("plan workshop task")) {
      return "Next action: prepare a workshop-focused task plan.";
    }
    if (this.history.includes("plan home task")) {
      return "Next action: prepare a home-focused task plan.";
    }
    return "Next action: confirm the main objective and break it into steps.";
  }
}
