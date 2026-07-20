import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConversationService } from "../src/agent/conversationService.js";
import { SafetyEnvelope } from "../src/agent/safetyEnvelope.js";
import { WorkshopEngine } from "../src/agent/workshopEngine.js";
import { createAgentSystem } from "../src/agent/system.js";
import { runSystemCheck } from "../src/agent/systemCheck.js";
import type { InteractionRecord } from "../src/agent/learningEngine.js";

describe("agent conversation parsing", () => {
  it("extracts the job intent and jobId entity", () => {
    const parsed = new ConversationService().parse("Start job j1");
    assert.equal(parsed.intent, "start_job");
    assert.equal(parsed.entities.jobId, "j1");
  });

  it("falls back to unknown for unrelated text", () => {
    assert.equal(new ConversationService().parse("nice weather").intent, "unknown");
  });
});

describe("agent safety envelope", () => {
  const safety = new SafetyEnvelope();

  it("blocks tool use without a toolId and consuming a non-positive quantity", () => {
    assert.equal(
      safety.evaluate({ domain: "workshop", action: "use_tool", payload: {}, outputs: [] }).status,
      "blocked",
    );
    assert.equal(
      safety.evaluate({
        domain: "workshop",
        action: "consume_item",
        payload: { itemId: "i1", quantity: 0 },
        outputs: [],
      }).status,
      "blocked",
    );
  });

  it("allows a well-formed workshop action", () => {
    assert.equal(
      safety.evaluate({
        domain: "workshop",
        action: "use_tool",
        payload: { toolId: "t1" },
        outputs: [],
      }).status,
      "ok",
    );
  });
});

describe("agent domain engine", () => {
  it("marks a tool in use and rejects an unknown tool", async () => {
    const workshop = new WorkshopEngine();
    assert.deepEqual(await workshop.handle("use_tool", { toolId: "t1" }), {
      id: "t1",
      name: "Drill",
      inUse: true,
    });
    assert.deepEqual(await workshop.handle("use_tool", { toolId: "nope" }), {
      error: "Tool not found",
    });
  });
});

describe("agent Z-state gating", () => {
  const fiveRecords: InteractionRecord[] = Array.from({ length: 5 }, () => ({
    timestamp: new Date(0),
    intent: "start_job",
    success: true,
  }));

  it("refuses to activate without enough history", () => {
    const { zState } = createAgentSystem();
    const report = zState.canActivate(
      "start_job",
      [{ module: "business", action: "start_job" }],
      [],
    );
    assert.equal(report.active, false);
    assert.ok(report.reasons.includes("Insufficient adaptive history"));
  });

  it("activates and returns advisory proposals when safe, healthy, and experienced", () => {
    const { zState } = createAgentSystem();
    const report = zState.canActivate(
      "start_job",
      [{ module: "business", action: "start_job" }],
      fiveRecords,
    );
    assert.equal(report.active, true);
    assert.ok(report.proposals);
    assert.equal(report.proposals?.workflow.intent, "start_job");
  });
});

describe("agent full system check", () => {
  it("runs the scenario end to end with all validations passing", async () => {
    const report = await runSystemCheck(createAgentSystem());
    assert.equal(report.parsed.intent, "start_job");
    assert.ok(report.plan.steps.length > 0);
    assert.equal(report.allValid, true, JSON.stringify(report.validation, null, 2));
    // After a start_job interaction, the prediction layer suggests prepare_job.
    assert.equal(report.predictedNextIntent, "prepare_job");
    // The consolidation lineage must reference a short-term entry that exists.
    const lineage = report.memorySnapshot.lineage[0];
    assert.ok(lineage);
    for (const sourceId of lineage.sourceIds) {
      assert.ok(report.memorySnapshot.shortTerm.some((entry) => entry.id === sourceId));
    }
  });
});
