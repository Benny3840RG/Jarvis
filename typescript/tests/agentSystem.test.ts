import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConversationService } from "../src/agent/conversationService.js";
import { HealthMonitor } from "../src/agent/healthMonitor.js";
import { PredictionEngine } from "../src/agent/predictionEngine.js";
import { RuleEvolution } from "../src/agent/ruleEvolution.js";
import { SafetyEnvelope } from "../src/agent/safetyEnvelope.js";
import { WorkflowGenerator } from "../src/agent/workflowGenerator.js";
import { WorkshopEngine } from "../src/agent/workshopEngine.js";
import { ZState } from "../src/agent/zState.js";
import { createAgentSystem } from "../src/agent/system.js";
import { runGovernedAutonomyDemo } from "../src/agent/autonomyDemo.js";
import { runSystemCheck } from "../src/agent/systemCheck.js";
import type { HealthMetric } from "../src/agent/healthMonitor.js";
import type { InteractionRecord } from "../src/agent/learningEngine.js";

function historyOf(intent: string, count = 5): InteractionRecord[] {
  return Array.from({ length: count }, () => ({
    timestamp: new Date(0),
    intent,
    success: true,
  }));
}

function provenHealth(): HealthMonitor {
  return new HealthMonitor([{ name: "orchestrator_latency_ms", value: 20, status: "ok" }]);
}

describe("agent conversation parsing", () => {
  it("extracts the job intent and jobId entity", () => {
    const parsed = new ConversationService().parse("Start job j1");
    assert.equal(parsed.intent, "start_job");
    assert.equal(parsed.entities.jobId, "j1");
  });

  it("falls back to unknown for unrelated text", () => {
    assert.equal(new ConversationService().parse("nice weather").intent, "unknown");
  });

  it("maps synonym phrasings to the same canonical intent and jobId", () => {
    const conversation = new ConversationService();
    for (const [text, intent] of [
      ["kick off job j2", "start_job"],
      ["begin job j2", "start_job"],
      ["prep job j2", "prepare_job"],
      ["set up job j2", "prepare_job"],
      ["finish job j2", "complete_job"],
      ["close job j2", "complete_job"],
    ] as const) {
      const parsed = conversation.parse(text);
      assert.equal(parsed.intent, intent, text);
      assert.equal(parsed.entities.jobId, "j2", text);
    }
  });
});

describe("agent prediction chain", () => {
  const prediction = new PredictionEngine();

  it("predicts the job lifecycle order and stops at the end", () => {
    assert.equal(prediction.predictNextIntent(historyOf("start_job", 1)), "prepare_job");
    assert.equal(prediction.predictNextIntent(historyOf("prepare_job", 1)), "complete_job");
    assert.equal(prediction.predictNextIntent(historyOf("complete_job", 1)), null);
    assert.equal(prediction.predictNextIntent([]), null);
  });
});

describe("agent reliability gating", () => {
  it("reports unknown when no health evidence is available", () => {
    assert.equal(new HealthMonitor().overallStatus(), "unknown");
  });

  it("keeps health evidence immutable after validation", () => {
    const suppliedMetrics: HealthMetric[] = [
      { name: "orchestrator_latency_ms", value: 20, status: "ok" },
    ];
    const health = new HealthMonitor(suppliedMetrics);

    suppliedMetrics.push({ name: "domain_errors_last_minute", value: 99, status: "critical" });
    suppliedMetrics[0] = { name: "orchestrator_latency_ms", value: 999, status: "critical" };

    const exposedMetrics = health.getMetrics();
    assert.equal(health.overallStatus(), "ok");
    assert.equal(exposedMetrics.length, 1);
    assert.deepEqual(exposedMetrics[0], {
      name: "orchestrator_latency_ms",
      value: 20,
      status: "ok",
    });
    assert.equal(Object.isFrozen(exposedMetrics), true);
    assert.equal(Object.isFrozen(exposedMetrics[0]), true);
    assert.throws(() => {
      (exposedMetrics as HealthMetric[]).push({
        name: "domain_errors_last_minute",
        value: 99,
        status: "critical",
      });
    }, TypeError);
    assert.throws(() => {
      (exposedMetrics[0] as { status: HealthMetric["status"] }).status = "critical";
    }, TypeError);
    assert.equal(health.overallStatus(), "ok");
  });

  it("refuses autonomy when reliability is critical, even with ample history", () => {
    const criticalHealth = new HealthMonitor([
      { name: "domain_errors_last_minute", value: 99, status: "critical" },
    ]);
    const zState = new ZState(
      new WorkflowGenerator(),
      new RuleEvolution(),
      new SafetyEnvelope(),
      criticalHealth,
      () => ({}),
    );
    const report = zState.canActivate(
      "start_job",
      [{ module: "business", action: "start_job" }],
      historyOf("start_job", 10),
    );
    assert.equal(report.active, false);
    assert.ok(report.reasons.includes("Reliability status: critical"));
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

  it("flags a step that returned an error output as a consistency warning", () => {
    const result = safety.evaluate({
      domain: "business",
      action: "start_job",
      payload: { jobId: "j1" },
      outputs: [{ error: "Job not found" }, { jobId: "j1", status: "prepared" }],
    });
    assert.equal(result.status, "warning");
    assert.ok(result.reasons.some((reason) => reason.includes("error")));
  });

  it("warns when a home scene is activated without a completed job", () => {
    const result = safety.evaluate({
      domain: "workshop",
      action: "complete_job",
      payload: { jobId: "j1" },
      outputs: [
        { jobId: "j1", status: "prepared" },
        { activated: "arrival", description: "Lights on" },
      ],
    });
    assert.equal(result.status, "warning");
    assert.ok(result.reasons.some((reason) => reason.includes("without a completed job")));
  });

  it("allows a home scene activation once a job is completed in the same plan", () => {
    const result = safety.evaluate({
      domain: "workshop",
      action: "complete_job",
      payload: { jobId: "j1" },
      outputs: [
        { jobId: "j1", status: "completed" },
        { activated: "arrival", description: "Lights on" },
      ],
    });
    assert.equal(result.status, "ok");
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

  it("refuses to activate without health evidence, even with ample history", () => {
    const { zState } = createAgentSystem();
    const report = zState.canActivate(
      "start_job",
      [{ module: "business", action: "start_job" }],
      fiveRecords,
    );
    assert.equal(report.active, false);
    assert.deepEqual(report.reasons, ["Reliability status: unknown"]);
  });

  it("activates and returns advisory proposals when safe, healthy, and experienced", () => {
    const { zState } = createAgentSystem(provenHealth());
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

describe("agent governed autonomy demo", () => {
  it("gates autonomy without history, then activates with advisory proposals", () => {
    const report = runGovernedAutonomyDemo(createAgentSystem(provenHealth()));

    assert.equal(report.beforeWarmup.active, false);
    assert.ok(report.beforeWarmup.reasons.includes("Insufficient adaptive history"));

    assert.equal(report.afterWarmup.active, true);
    assert.ok(report.afterWarmup.proposals);
    assert.equal(report.afterWarmup.proposals?.workflow.intent, "start_job");
    // Five successful interactions cross the rule-evolution threshold.
    assert.deepEqual(
      report.afterWarmup.proposals?.ruleChanges.map((change) => change.change),
      ["increase_weight"],
    );
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
