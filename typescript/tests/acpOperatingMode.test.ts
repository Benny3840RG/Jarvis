import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAcpConsultationFailure,
  isAcpDecision,
  resolveAcpModePolicy,
  resolveAcpOperatingModeFromEnv,
  type AcpConsultationClassification,
} from "../src/acp/acpOperatingMode.js";

const FAILURES: readonly AcpConsultationClassification[] = [
  "unavailable",
  "timeout",
  "worker_crash",
  "malformed_response",
  "request_mismatch",
  "output_limit_exceeded",
  "internal_transport_error",
];
const DECISIONS: readonly AcpConsultationClassification[] = ["allow", "deny", "abstain"];

describe("ACP failure taxonomy", () => {
  it("classifies decisions and failures disjointly and completely", () => {
    for (const d of DECISIONS) {
      assert.equal(isAcpDecision(d), true, `${d} is a decision`);
      assert.equal(isAcpConsultationFailure(d), false, `${d} is not a failure`);
    }
    for (const f of FAILURES) {
      assert.equal(isAcpDecision(f), false, `${f} is not a decision`);
      assert.equal(isAcpConsultationFailure(f), true, `${f} is a failure`);
    }
  });
});

describe("ACP mode policy — disabled", () => {
  it("proceeds iff governed approval is present and never consults", () => {
    assert.equal(
      resolveAcpModePolicy({ mode: "disabled", governedApprovalPresent: true }).proceed,
      true,
    );
    assert.equal(
      resolveAcpModePolicy({ mode: "disabled", governedApprovalPresent: false }).proceed,
      false,
    );
    // A classification is irrelevant in disabled mode.
    assert.equal(
      resolveAcpModePolicy({
        mode: "disabled",
        governedApprovalPresent: true,
        classification: "deny",
      }).proceed,
      true,
    );
  });
});

describe("ACP mode policy — advisory", () => {
  it("blocks when no governed approval, regardless of the peer result", () => {
    for (const c of [...DECISIONS, ...FAILURES]) {
      const out = resolveAcpModePolicy({
        mode: "advisory",
        governedApprovalPresent: false,
        classification: c,
      });
      assert.equal(out.proceed, false, `advisory + no governed + ${c} must block`);
    }
  });

  it("proceeds on allow and abstain when governed approval is present", () => {
    for (const c of ["allow", "abstain"] as const) {
      const out = resolveAcpModePolicy({
        mode: "advisory",
        governedApprovalPresent: true,
        classification: c,
      });
      assert.equal(out.proceed, true);
      assert.equal(out.disagreement, false);
    }
  });

  it("proceeds on deny but records a disagreement (never removes governed authority)", () => {
    const out = resolveAcpModePolicy({
      mode: "advisory",
      governedApprovalPresent: true,
      classification: "deny",
    });
    assert.equal(out.proceed, true);
    assert.equal(out.disagreement, true);
  });

  it("proceeds on every failure and records it as evidence", () => {
    for (const c of FAILURES) {
      const out = resolveAcpModePolicy({
        mode: "advisory",
        governedApprovalPresent: true,
        classification: c,
      });
      assert.equal(out.proceed, true, `advisory + governed + ${c} must proceed`);
      assert.equal(out.disagreement, false);
      assert.match(out.reason, new RegExp(c));
    }
  });
});

describe("ACP mode policy — required", () => {
  it("blocks when no governed approval, regardless of the peer result", () => {
    for (const c of [...DECISIONS, ...FAILURES]) {
      const out = resolveAcpModePolicy({
        mode: "required",
        governedApprovalPresent: false,
        classification: c,
      });
      assert.equal(out.proceed, false, `required + no governed + ${c} must block`);
    }
  });

  it("proceeds only on allow and abstain when governed approval is present", () => {
    for (const c of ["allow", "abstain"] as const) {
      assert.equal(
        resolveAcpModePolicy({
          mode: "required",
          governedApprovalPresent: true,
          classification: c,
        }).proceed,
        true,
      );
    }
  });

  it("blocks on deny and on every failure even with governed approval", () => {
    for (const c of ["deny", ...FAILURES] as AcpConsultationClassification[]) {
      const out = resolveAcpModePolicy({
        mode: "required",
        governedApprovalPresent: true,
        classification: c,
      });
      assert.equal(out.proceed, false, `required + governed + ${c} must block`);
    }
  });

  it("treats a governed-approved required consult with no classification as unavailable (blocks)", () => {
    const out = resolveAcpModePolicy({ mode: "required", governedApprovalPresent: true });
    assert.equal(out.proceed, false);
    assert.match(out.reason, /unavailable/);
  });
});

describe("resolveAcpOperatingModeFromEnv", () => {
  it("defaults to disabled when unset, blank, or unrecognised", () => {
    assert.equal(resolveAcpOperatingModeFromEnv({}), "disabled");
    assert.equal(resolveAcpOperatingModeFromEnv({ JARVIS_ACP_MODE: "   " }), "disabled");
    assert.equal(resolveAcpOperatingModeFromEnv({ JARVIS_ACP_MODE: "enforce" }), "disabled");
  });

  it("reads advisory and required case-insensitively", () => {
    assert.equal(resolveAcpOperatingModeFromEnv({ JARVIS_ACP_MODE: "advisory" }), "advisory");
    assert.equal(resolveAcpOperatingModeFromEnv({ JARVIS_ACP_MODE: "REQUIRED" }), "required");
    assert.equal(resolveAcpOperatingModeFromEnv({ JARVIS_ACP_MODE: " Disabled " }), "disabled");
  });
});
