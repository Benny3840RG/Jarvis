export type IntentStats = {
  total: number;
  successes: number;
  failures: number;
  /** Successful interactions divided by total; 0 when nothing has been recorded. */
  successRate: number;
};

export class LearningEngine {
  private readonly history: string[] = [];
  private readonly outcomes = new Map<string, { successes: number; failures: number }>();

  observe(event: string): void {
    this.history.push(event.toLowerCase());
  }

  /** Records whether handling an interaction for the given intent succeeded. */
  record(intent: string, success: boolean): void {
    const entry = this.outcomes.get(intent) ?? { successes: 0, failures: 0 };
    if (success) entry.successes += 1;
    else entry.failures += 1;
    this.outcomes.set(intent, entry);
  }

  /** Per-intent success and failure counts with a derived success rate. */
  getStats(): Record<string, IntentStats> {
    const stats: Record<string, IntentStats> = {};
    for (const [intent, entry] of this.outcomes) {
      const total = entry.successes + entry.failures;
      stats[intent] = {
        total,
        successes: entry.successes,
        failures: entry.failures,
        successRate: total === 0 ? 0 : entry.successes / total,
      };
    }
    return stats;
  }

  /** Intents whose recorded failures outnumber their successes. */
  strugglingIntents(): string[] {
    return Object.entries(this.getStats())
      .filter(([, stats]) => stats.failures > stats.successes)
      .map(([intent]) => intent);
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
