import type { Payload } from "./types.js";

export interface ShortTermMemoryEntry {
  id: string;
  timestamp: Date;
  intent: string;
  context: Payload;
}

export interface LongTermMemoryEntry {
  id: string;
  createdAt: Date;
  summary: string;
  tags: string[];
}

export interface Profile {
  id: string;
  name: string;
  traits: Payload;
}

export interface MemoryLineage {
  id: string;
  sourceIds: string[];
  notes?: string;
}
