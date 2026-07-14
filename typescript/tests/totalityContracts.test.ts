import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertProjectMemoryIntegrity,
  type ProjectMemory,
} from "../src/runtime/projectMemory.js";
import { assertRequestAuthority, type TotalityRequest } from "../src/runtime/totalityContracts.js";
import { routeTotalityTask } from "../src/runtime/totalityPolicy.js";
import { validateTotalityResult } from "../src/runtime/validation.js";

function makeProject(): ProjectMemory {
  return {
    projectId: "project-1",
    projectName: "Crawler",
    projectType: "vehicle",
    status: "active",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    revision: 1,
    domains: ["mechanical", "electrical"],
    summary: "Test project",
    components: [],
    facts: [],
    assumptions: [],
    constraints: [],
    measurements: [],
    decisions: [],
    risks: [],
    tasks: [],
    preferences: {
      outputStyle: "for_benny_engineering",
      communicationTone: "direct",
      detailLevel: "technical",
      unitSystem: "metric",
      locale: "en-AU",
    },
    events: [],
  };
}

describe("Totality contracts", () => {
  it("accepts a valid project memory record", () => {
    assert.doesNotThrow(() => assertProjectMemoryIntegrity(makeProject()));
  });

  it("rejects authoritative inferred facts", () => {
    const project = makeProject();
    project.facts.push({
      factId: "fact-1",
      statement: "Unverified material thickness",
      source: "inference",
      confidence: 1,
      recordedAt: "2026-07-15T00:00:00.000Z",
    });

    assert.throws(() => assertProjectMemoryIntegrity(project), /cannot be authoritative/);
  });

  it("rejects duplicate measurement identities", () => {
    const project = makeProject();
    project.measurements.push(
      {
        measurementId: "measurement-1",
        name: "Wheelbase",
        value: 800,
        unit: "mm",
        source: "user",
      },
      {
        measurementId: "measurement-2",
        name: "wheelbase",
        value: 840,
        unit: "MM",
        source: "file",
      },
    );

    assert.throws(() => assertProjectMemoryIntegrity(project), /duplicate measurement/);
  });

  it("blocks high-risk results without controls", () => {
    const routing = routeTotalityTask({ taskType: "fabrication_planning" });
    const report = validateTotalityResult({
      routing,
      assumptions: ["Material grade is unverified"],
      hazards: ["Stored energy"],
      controls: [],
    });

    assert.equal(report.passed, false);
    assert.ok(report.blockingFailures.includes("High-risk work has no explicit controls."));
  });

  it("blocks authority escalation", () => {
    const routing = routeTotalityTask({ taskType: "automation_design" });
    const report = validateTotalityResult({
      routing,
      assumptions: ["Controller model is unverified"],
      hazards: ["Unexpected actuator motion"],
      controls: ["Physical isolation and guarded test mode"],
      requestedAuthority: { toolAuthority: "T3", actionState: "execute" },
    });

    assert.equal(report.passed, false);
    assert.ok(report.blockingFailures.includes("Requested action exceeds authority."));
  });

  it("enforces the caller's maximum authority", () => {
    const routing = routeTotalityTask({ taskType: "engineering_analysis" });
    const request: TotalityRequest = {
      requestId: "request-1",
      projectId: null,
      sessionId: "session-1",
      taskType: "engineering_analysis",
      domainContext: ["mechanical"],
      goal: "Review a bracket",
      constraints: [],
      inputs: [],
      outputStyle: "for_benny_engineering",
      actionPolicy: {
        maximumToolAuthority: "T0",
        requireApprovalBeforeExecution: true,
      },
    };

    assert.throws(() => assertRequestAuthority(request, routing), /exceeds the request action policy/);
  });
});
