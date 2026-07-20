import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemoryConsolidator } from "../src/agent/memoryConsolidator.js";
import { MemoryManager } from "../src/agent/memoryManager.js";

describe("agent memory consolidation", () => {
  it("bounds short-term memory and evicts the oldest entries", () => {
    const consolidator = new MemoryConsolidator(3);
    for (let i = 0; i < 10; i += 1) {
      consolidator.addShortTerm("start_job", { index: i });
    }
    const shortTerm = consolidator.getShortTerm();
    assert.equal(shortTerm.length, 3);
    // The three surviving entries are the most recent ones.
    assert.deepEqual(
      shortTerm.map((entry) => entry.context.index),
      [7, 8, 9],
    );
  });

  it("keeps consolidation lineage referencing only surviving short-term entries", () => {
    const consolidator = new MemoryConsolidator(3);
    for (let i = 0; i < 10; i += 1) {
      consolidator.addShortTerm("start_job", { index: i });
    }
    consolidator.consolidateInteractions([
      { timestamp: new Date(0), intent: "start_job", success: true },
    ]);

    const lineage = consolidator.getLineage()[0];
    const survivingIds = new Set(consolidator.getShortTerm().map((entry) => entry.id));
    assert.ok(lineage);
    assert.equal(lineage.sourceIds.length, 3);
    for (const sourceId of lineage.sourceIds) {
      assert.ok(survivingIds.has(sourceId), `orphaned lineage id: ${sourceId}`);
    }
  });

  it("stores and updates stable profile traits", () => {
    const manager = new MemoryManager(new MemoryConsolidator());
    manager.rememberProfile("benny", "Benny", { timezone: "Australia/Melbourne" });
    manager.rememberProfile("benny", "Benny", { prefersBoring: true });

    const profile = manager.getProfile("benny");
    assert.deepEqual(profile?.traits, {
      timezone: "Australia/Melbourne",
      prefersBoring: true,
    });
    assert.equal(manager.snapshot().profiles.length, 1);
    assert.equal(manager.getProfile("unknown"), undefined);
  });
});
