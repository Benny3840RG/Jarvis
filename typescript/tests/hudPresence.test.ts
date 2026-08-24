import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SystemStatus } from "../src/http/contracts.js";
import { deriveHudPresence } from "../src/hud/hudPresence.js";

const BASE: SystemStatus = {
  status: "ok",
  version: "0.1.0",
  sourceVersion: "hud-presence-test",
  provider: {
    name: "json",
    reachability: "ok",
    authentication: "not-required",
    schemaCompatibility: "compatible",
    deploymentVersion: null,
  },
  reconciliation: { state: "disabled", enabled: false },
  integrations: [],
  timezone: "Australia/Melbourne",
  layers: {
    runtime: { status: "ready" },
    domains: { status: "ready" },
    integration: { status: "ready" },
    orchestration: { status: "ready" },
    safety: { status: "ready" },
    adaptive: { status: "ready" },
    autonomy: { status: "ready" },
    reliability: { status: "ready" },
  },
  zState: "active",
  checkedAt: "2026-08-21T00:00:00.000Z",
};

describe("deriveHudPresence", () => {
  it("stays connecting until authoritative status arrives", () => {
    assert.equal(deriveHudPresence({}), "connecting");
    assert.equal(deriveHudPresence({ status: null }), "connecting");
  });

  it("maps real runtime states without inventing listening or processing", () => {
    assert.equal(deriveHudPresence({ status: BASE }), "idle");
    assert.equal(deriveHudPresence({ status: { ...BASE, status: "unavailable" } }), "offline");
    assert.equal(deriveHudPresence({ status: { ...BASE, status: "degraded" } }), "degraded");
    assert.equal(deriveHudPresence({ status: { ...BASE, zState: "suspended" } }), "blocked");
    assert.equal(
      deriveHudPresence({
        status: { ...BASE, reconciliation: { state: "degraded", enabled: true } },
      }),
      "reconciling",
    );
    assert.equal(
      deriveHudPresence({ status: BASE, proposedApprovalCount: 2 }),
      "waiting_for_approval",
    );
    const derived = [
      deriveHudPresence({ status: BASE }),
      deriveHudPresence({ status: { ...BASE, status: "degraded" } }),
      deriveHudPresence({ status: BASE, proposedApprovalCount: 1 }),
    ];
    for (const presence of derived) {
      assert.notEqual(presence, "listening");
      assert.notEqual(presence, "processing");
      assert.notEqual(presence, "executing");
    }
  });
});
