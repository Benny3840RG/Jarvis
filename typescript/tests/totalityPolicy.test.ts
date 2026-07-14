import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { routeTotalityTask } from "../src/runtime/totalityPolicy.js";

describe("Totality mode routing", () => {
  it("routes engineering analysis to engineering mode", () => {
    const result = routeTotalityTask({ taskType: "engineering_analysis" });

    assert.equal(result.primaryMode, "engineering");
    assert.equal(result.permission.reasoningLevel, "R2");
    assert.equal(result.permission.actionState, "propose");
  });

  it("honours an explicit client output override", () => {
    const result = routeTotalityTask({
      taskType: "engineering_analysis",
      outputStyle: "for_client",
    });

    assert.equal(result.primaryMode, "client");
    assert.equal(result.confidence, 1);
    assert.ok(result.reasonCodes.includes("STYLE_OVERRIDE_FOR_CLIENT"));
  });

  it("injects safety mode for hazardous fabrication work", () => {
    const result = routeTotalityTask({
      taskType: "fabrication_planning",
      safetySignals: ["cutting", "welding"],
    });

    assert.equal(result.primaryMode, "fabrication");
    assert.equal(result.permission.riskLevel, "high");
    assert.ok(result.supportingModes.includes("safety"));
    assert.ok(result.reasonCodes.includes("SAFETY_INJECTION"));
  });

  it("injects integration mode for multi-domain tasks", () => {
    const result = routeTotalityTask({
      taskType: "automation_design",
      domainContext: ["electrical", "mechanical", "control"],
    });

    assert.equal(result.primaryMode, "automation");
    assert.ok(result.supportingModes.includes("integration"));
    assert.ok(result.reasonCodes.includes("MULTI_DOMAIN_INTEGRATION"));
  });

  it("does not grant execution authority from task risk", () => {
    const result = routeTotalityTask({
      taskType: "safety_review",
      safetySignals: ["critical"],
    });

    assert.equal(result.permission.riskLevel, "critical");
    assert.equal(result.permission.toolAuthority, "T1");
    assert.equal(result.permission.actionState, "propose");
  });
});
