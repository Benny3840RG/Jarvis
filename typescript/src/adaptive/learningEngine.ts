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

  /**
   * Returns personalized tips derived from the current session's usage patterns.
   * Each tip is a short, actionable string. When there is nothing notable to
   * report an encouraging fallback tip is included so the array is never empty.
   */
  tips(): string[] {
    const result: string[] = [];
    const stats = this.getStats();
    const struggling = this.strugglingIntents();

    for (const intent of struggling) {
      result.push(
        `"${intent}" commands have been failing — try rephrasing or type 'help' for the correct syntax.`,
      );
    }

    const intents = Object.keys(stats);
    if (intents.length > 0) {
      const topIntent = intents.reduce((best, intent) =>
        (stats[intent]?.total ?? 0) > (stats[best]?.total ?? 0) ? intent : best,
      );
      result.push(
        `Your most-used intent this session is "${topIntent}". Consider creating a task to track that work.`,
      );
    }

    const hasPlanning = this.history.some((e) => e.includes("plan"));
    if (!hasPlanning) {
      result.push("You haven't used planning mode yet — try typing a planning request to generate a structured workflow.");
    }

    const hasSummary = this.history.some((e) => e.includes("summary"));
    if (!hasSummary) {
      result.push("Type 'summary' at any time to get a quick overview of your open tasks.");
    }

    if (result.length === 0) {
      result.push("Your session looks healthy. Keep it up — type 'summary' to review your open tasks.");
    }

    return result;
  }
}
