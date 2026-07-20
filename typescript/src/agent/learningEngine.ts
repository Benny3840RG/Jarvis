export interface InteractionRecord {
  timestamp: Date;
  intent: string;
  success: boolean;
  notes?: string;
}

export type IntentStats = Record<string, { total: number; success: number }>;

export class LearningEngine {
  private readonly history: InteractionRecord[] = [];

  record(intent: string, success: boolean, notes?: string): void {
    this.history.push({ timestamp: new Date(), intent, success, notes });
  }

  getHistory(): InteractionRecord[] {
    return this.history;
  }

  getStats(): IntentStats {
    const byIntent: IntentStats = {};
    for (const entry of this.history) {
      const stats = byIntent[entry.intent] ?? { total: 0, success: 0 };
      stats.total += 1;
      if (entry.success) stats.success += 1;
      byIntent[entry.intent] = stats;
    }
    return byIntent;
  }
}
