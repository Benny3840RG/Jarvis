import type { InteractionRecord } from "./learningEngine.js";
import type {
  LongTermMemoryEntry,
  MemoryLineage,
  Profile,
  ShortTermMemoryEntry,
} from "./memoryTypes.js";
import type { Payload } from "./types.js";

export class MemoryConsolidator {
  private readonly shortTerm: ShortTermMemoryEntry[] = [];
  private readonly longTerm: LongTermMemoryEntry[] = [];
  private readonly profiles: Profile[] = [];
  private readonly lineage: MemoryLineage[] = [];
  private sequence = 0;

  constructor(private readonly maxShortTerm = 100) {}

  private nextId(prefix: string): string {
    return `${prefix}_${(this.sequence += 1)}`;
  }

  addShortTerm(intent: string, context: Payload): ShortTermMemoryEntry {
    const entry: ShortTermMemoryEntry = {
      id: this.nextId("stm"),
      timestamp: new Date(),
      intent,
      context,
    };
    this.shortTerm.push(entry);
    if (this.shortTerm.length > this.maxShortTerm) this.shortTerm.shift();
    return entry;
  }

  /** Stores or updates a stable profile of traits, keyed by id. */
  upsertProfile(id: string, name: string, traits: Payload): Profile {
    const existing = this.profiles.find((profile) => profile.id === id);
    if (existing) {
      existing.name = name;
      existing.traits = { ...existing.traits, ...traits };
      return existing;
    }
    const profile: Profile = { id, name, traits };
    this.profiles.push(profile);
    return profile;
  }

  getProfile(id: string): Profile | undefined {
    return this.profiles.find((profile) => profile.id === id);
  }

  consolidateInteractions(history: InteractionRecord[]): LongTermMemoryEntry | null {
    if (history.length === 0) return null;

    const entry: LongTermMemoryEntry = {
      id: this.nextId("ltm"),
      createdAt: new Date(),
      summary: `Total interactions: ${history.length}`,
      tags: ["summary", "interaction"],
    };
    this.longTerm.push(entry);

    // Lineage references the actual short-term entry IDs that currently exist.
    this.lineage.push({
      id: this.nextId("lin"),
      sourceIds: this.shortTerm.map((short) => short.id),
      notes: "Consolidated from short-term memory",
    });

    return entry;
  }

  getShortTerm(): ShortTermMemoryEntry[] {
    return this.shortTerm;
  }

  getLongTerm(): LongTermMemoryEntry[] {
    return this.longTerm;
  }

  getProfiles(): Profile[] {
    return this.profiles;
  }

  getLineage(): MemoryLineage[] {
    return this.lineage;
  }
}
