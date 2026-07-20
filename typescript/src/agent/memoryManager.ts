import type { InteractionRecord } from "./learningEngine.js";
import type { MemoryConsolidator } from "./memoryConsolidator.js";
import type {
  LongTermMemoryEntry,
  MemoryLineage,
  Profile,
  ShortTermMemoryEntry,
} from "./memoryTypes.js";
import type { Payload } from "./types.js";

export interface MemorySnapshot {
  shortTerm: ShortTermMemoryEntry[];
  longTerm: LongTermMemoryEntry[];
  profiles: Profile[];
  lineage: MemoryLineage[];
}

export class MemoryManager {
  constructor(private readonly consolidator: MemoryConsolidator) {}

  addShortTerm(intent: string, context: Payload): void {
    this.consolidator.addShortTerm(intent, context);
  }

  consolidate(history: InteractionRecord[]): LongTermMemoryEntry | null {
    return this.consolidator.consolidateInteractions(history);
  }

  snapshot(): MemorySnapshot {
    return {
      shortTerm: this.consolidator.getShortTerm(),
      longTerm: this.consolidator.getLongTerm(),
      profiles: this.consolidator.getProfiles(),
      lineage: this.consolidator.getLineage(),
    };
  }
}
