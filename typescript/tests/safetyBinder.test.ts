import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  IMMUTABLE_SAFETY_CATEGORIES,
  bindSafety,
  type SafetyBindingInput,
} from "../src/safety/safetyBinder.js";

function validExternalInput(overrides: Partial<SafetyBindingInput> = {}): SafetyBindingInput {
  return {
    phase: "tool-execute",
    riskLevel: "moderate",
    hazards: ["external side effect"],
    controls: ["operator approval", "provider reconciliation"],
    requiredAuthority: "T2",
    grantedAuthority: "T3",
    actionState: "execute",
    requiresApproval: true,
    approvalPresent: true,
    destructive: true,
    externalEffect: true,
    idempotencyKey: "action-1:live",
    correlationId: "request-1",
    payload: { recipient: "test@example.com" },
    stateValid: true,
    outcome: "pending",
    recoveryAvailable: true,
    reliabilityHealthy: true,
    proposalSafe: true,
    toolAllowlisted: true,
    ...overrides,
  };
}

describe("immutable safety-category binder", () => {
  it("matches the OpenAPI authority metadata", async () => {
    const openapi = JSON.parse(
      await readFile(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
    ) as {
      "x-jarvis-architecture": { immutableSafetyCategories: readonly string[] };
    };

    assert.deepEqual(
      IMMUTABLE_SAFETY_CATEGORIES,
      openapi["x-jarvis-architecture"].immutableSafetyCategories,
    );
  });

  it("assesses every authoritative category and freezes the validated evidence", () => {
    const result = bindSafety(validExternalInput());

    assert.equal(result.status, "pass");
    assert.deepEqual(
      result.categories.map((category) => category.category),
      IMMUTABLE_SAFETY_CATEGORIES,
    );
    assert.ok(result.categories.every((category) => category.status === "pass"));
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.categories), true);
    assert.ok(result.categories.every((category) => Object.isFrozen(category)));
    assert.throws(() => {
      (result.categories as unknown as Array<unknown>).push({});
    }, TypeError);
    assert.throws(() => {
      (result.categories[0] as { status: string }).status = "blocked";
    }, TypeError);
  });

  it("blocks high-risk transitions without both hazards and controls", () => {
    const result = bindSafety(
      validExternalInput({
        riskLevel: "high",
        hazards: [],
        controls: [],
      }),
    );

    assert.equal(result.status, "blocked");
    const domain = result.categories.find((category) => category.category === "domain");
    assert.equal(domain?.status, "blocked");
    assert.deepEqual(domain?.reasons, [
      "High or critical risk requires at least one identified hazard.",
      "High or critical risk requires at least one explicit control.",
    ]);
  });

  it("blocks an external effect that has no approval, authority, or recovery path", () => {
    const result = bindSafety(
      validExternalInput({
        grantedAuthority: "T1",
        actionState: "propose",
        approvalPresent: false,
        recoveryAvailable: false,
        reliabilityHealthy: false,
      }),
    );

    assert.equal(result.status, "blocked");
    assert.equal(
      result.categories.find((category) => category.category === "tool-action")?.status,
      "blocked",
    );
    assert.equal(
      result.categories.find((category) => category.category === "reliability")?.status,
      "blocked",
    );
  });

  it("blocks credential-like payload fields from crossing the tool-action boundary", () => {
    const result = bindSafety(
      validExternalInput({
        payload: { accessToken: "secret-value" },
      }),
    );

    assert.equal(result.status, "blocked");
    const toolAction = result.categories.find((category) => category.category === "tool-action");
    assert.equal(toolAction?.status, "blocked");
    assert.deepEqual(toolAction?.reasons, [
      "Credential-like fields must not cross the governed action boundary.",
    ]);
  });

  it("blocks invalid state and missing reliability evidence", () => {
    const result = bindSafety(
      validExternalInput({
        stateValid: false,
        idempotencyKey: "",
        correlationId: "",
        reliabilityHealthy: false,
      }),
    );

    assert.equal(result.status, "blocked");
    assert.equal(
      result.categories.find((category) => category.category === "memory")?.status,
      "pass",
    );
    assert.equal(
      result.categories.find((category) => category.category === "reliability")?.status,
      "blocked",
    );
  });
});
