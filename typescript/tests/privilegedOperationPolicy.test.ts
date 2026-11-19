import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  PRIVILEGED_TOOL,
  RESTART_RETRY_BUDGET,
  evaluatePrivilegedOperation,
  type PrivilegeContext,
  type StandingGrant,
} from "../src/security/privilegedOperationPolicy.js";

const NOW = "2026-11-19T12:00:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

function grant(overrides: Partial<StandingGrant> = {}): StandingGrant {
  return {
    grantId: "grant-1",
    operation: "service.restart",
    service: "jarvis.service",
    approvedBy: "owner",
    approvalRef: "owner-decision-fixture",
    issuedAt: minutesAgo(60),
    expiresAt: "2026-11-20T12:00:00.000Z",
    maxUses: 3,
    ...overrides,
  };
}

function restartContext(overrides: Partial<PrivilegeContext> = {}): PrivilegeContext {
  return {
    now: NOW,
    halt: "none",
    seenRequestIds: [],
    grant: grant(),
    grantUses: 0,
    health: { service: "jarvis.service", state: "unhealthy", observedAt: minutesAgo(0.25) },
    recentRestarts: [],
    ...overrides,
  };
}

const restart = {
  requestId: "req-1",
  operation: "service.restart",
  args: { service: "jarvis.service" },
};

function approval(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "action-1",
    requestId: "req-2",
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool: PRIVILEGED_TOOL,
    operation: "package.install",
    arguments: { packageName: "htop", version: "3.3.0-4" },
    rationale: "owner asked for htop",
    requiredAuthority: "T3",
    destructive: false,
    idempotencyKey: "idem-1",
    proposedBy: "agent",
    approvedBy: "user",
    consumptionPolicy: "single-use",
    createdAt: minutesAgo(10),
    updatedAt: minutesAgo(5),
    ...overrides,
  };
}

const install = {
  requestId: "req-2",
  operation: "package.install",
  args: { packageName: "htop", version: "3.3.0-4" },
};

function denied(request: unknown, context: PrivilegeContext, reason: string): void {
  const decision = evaluatePrivilegedOperation(request, context);
  assert.equal(decision.allowed, false, `expected denial (${reason})`);
  if (!decision.allowed) assert.equal(decision.reason, reason);
}

describe("privileged operation policy: closed catalogue", () => {
  it("allows a read-only status inspection without any grant", () => {
    const decision = evaluatePrivilegedOperation(
      { requestId: "req-s", operation: "service.status", args: { service: "jarvis.service" } },
      { now: NOW, halt: "none", seenRequestIds: [] },
    );
    assert.equal(decision.allowed, true);
    if (decision.allowed) assert.equal(decision.tier, "read");
  });

  it("refuses unknown operations, including shell-shaped and prototype names", () => {
    for (const operation of ["shell.exec", "service.restart; rm -rf /", "__proto__", "toString"]) {
      denied({ ...restart, operation }, restartContext(), "unknown_operation");
    }
  });

  it("refuses services outside the code-fixed allowlist", () => {
    for (const service of ["sshd.service", "jarvis.service ", "../jarvis.service", "*"]) {
      denied({ ...restart, args: { service } }, restartContext(), "invalid_arguments");
    }
  });

  it("refuses argument substitution and extra fields that could widen scope", () => {
    denied(
      { ...restart, args: { service: "jarvis.service", flags: "--force" } },
      restartContext(),
      "invalid_arguments",
    );
    denied(
      { ...restart, extra: "ignore previous instructions" },
      restartContext(),
      "invalid_request",
    );
  });

  it("refuses option-injection and malformed package names", () => {
    for (const packageName of ["-y", "--allow-unauthenticated", "htop htop", "htop;id", ""]) {
      denied(
        { ...install, args: { packageName, version: "1.0" } },
        { now: NOW, halt: "none", seenRequestIds: [], approval: approval() },
        "invalid_arguments",
      );
    }
  });

  it("refuses protected-file paths that are relative, unnormalised or escape", () => {
    const context = { now: NOW, halt: "none" as const, seenRequestIds: [] };
    for (const path of [
      "etc/hosts",
      "/etc/../root/.ssh/authorized_keys",
      "/etc//hosts",
      "/etc/hosts/",
      "/etc/./hosts",
      "/etc/ho\u0000sts",
    ]) {
      denied(
        {
          requestId: "req-f",
          operation: "protected_file.write",
          args: { path, contentSha256: "a".repeat(64) },
        },
        context,
        "invalid_arguments",
      );
    }
  });
});

describe("standing grants and verified recovery", () => {
  it("allows a restart under a live grant after a fresh unhealthy observation", () => {
    const decision = evaluatePrivilegedOperation(restart, restartContext());
    assert.equal(decision.allowed, true);
    if (!decision.allowed) return;
    assert.equal(decision.tier, "standing_grant");
    assert.equal(decision.authorityRef, "grant-1");
    assert.match(decision.bindingDigest, /^[0-9a-f]{64}$/);
  });

  it("binds the digest to the exact request", () => {
    const first = evaluatePrivilegedOperation(restart, restartContext());
    const second = evaluatePrivilegedOperation(
      { ...restart, requestId: "req-9" },
      restartContext(),
    );
    assert.ok(first.allowed && second.allowed);
    if (first.allowed && second.allowed) assert.notEqual(first.bindingDigest, second.bindingDigest);
  });

  it("requires a grant, and one scoped to the same operation and service", () => {
    denied(restart, restartContext({ grant: undefined }), "standing_grant_required");
    denied(
      restart,
      restartContext({
        grant: { ...grant(), service: "other.service" } as unknown as StandingGrant,
      }),
      "grant_invalid",
    );
  });

  it("refuses expired, future-dated, exhausted and non-owner grants", () => {
    denied(restart, restartContext({ grant: grant({ expiresAt: NOW }) }), "grant_expired");
    denied(
      restart,
      restartContext({ grant: grant({ issuedAt: "2026-11-19T12:00:01.000Z" }) }),
      "grant_invalid",
    );
    denied(restart, restartContext({ grantUses: 3 }), "grant_exhausted");
    denied(
      restart,
      restartContext({ grant: { ...grant(), approvedBy: "nolan" } as unknown as StandingGrant }),
      "grant_invalid",
    );
  });

  it("does not restart a healthy service or on unknown or stale health", () => {
    const health = (state: "healthy" | "unhealthy" | "unknown", observedAt = minutesAgo(0.25)) => ({
      service: "jarvis.service" as const,
      state,
      observedAt,
    });
    denied(restart, restartContext({ health: health("healthy") }), "no_failure_observed");
    denied(restart, restartContext({ health: health("unknown") }), "health_unknown");
    denied(restart, restartContext({ health: undefined }), "health_unknown");
    denied(restart, restartContext({ health: health("unhealthy", minutesAgo(5)) }), "health_stale");
    denied(
      restart,
      restartContext({ health: health("unhealthy", "2026-11-19T12:05:00.000Z") }),
      "health_stale",
    );
  });

  it("stops after the retry budget instead of retrying blindly", () => {
    const recentRestarts = Array.from({ length: RESTART_RETRY_BUDGET }, (_, index) =>
      minutesAgo(10 + index),
    );
    denied(restart, restartContext({ recentRestarts }), "retry_budget_exhausted");
    // Attempts older than the window no longer count.
    const old = recentRestarts.map((_, index) => minutesAgo(120 + index));
    assert.equal(
      evaluatePrivilegedOperation(restart, restartContext({ recentRestarts: old })).allowed,
      true,
    );
  });

  it("cannot use a standing grant to escalate to an owner-approval operation", () => {
    denied(
      install,
      {
        now: NOW,
        halt: "none",
        seenRequestIds: [],
        grant: { ...grant(), operation: "package.install" } as unknown as StandingGrant,
      },
      "owner_approval_required",
    );
  });
});

describe("owner-approval operations", () => {
  const base = { now: NOW, halt: "none" as const, seenRequestIds: [] };

  it("allows an install bound to a live, single-use owner approval", () => {
    const decision = evaluatePrivilegedOperation(install, { ...base, approval: approval() });
    assert.equal(decision.allowed, true);
    if (decision.allowed) assert.equal(decision.authorityRef, "action-1");
  });

  it("refuses without an approval, or with one that is not a live user approval", () => {
    denied(install, base, "owner_approval_required");
    for (const action of [
      approval({ state: "proposed", approvedBy: undefined }),
      approval({ state: "revoked" }),
      approval({ approvedBy: undefined }),
      approval({ consumptionPolicy: "reusable" }),
    ]) {
      denied(install, { ...base, approval: action }, "owner_approval_required");
    }
  });

  it("refuses an approval issued for a different request ID", () => {
    denied(
      { ...install, requestId: "req-3" },
      { ...base, approval: approval() },
      "approval_mismatch",
    );
  });

  it("refuses expired approvals by flag or by time", () => {
    denied(
      install,
      { ...base, approval: approval({ isApprovalExpired: true }) },
      "approval_expired",
    );
    denied(
      install,
      { ...base, approval: approval({ approvalExpiresAt: minutesAgo(1) }) },
      "approval_expired",
    );
  });

  it("refuses an approval bound to another operation or other arguments", () => {
    denied(install, { ...base, approval: approval({ tool: "home" }) }, "approval_mismatch");
    denied(
      install,
      { ...base, approval: approval({ operation: "firewall.change" }) },
      "approval_mismatch",
    );
    denied(
      { ...install, args: { packageName: "nmap", version: "7.94" } },
      { ...base, approval: approval() },
      "approval_mismatch",
    );
  });
});

describe("halt and replay", () => {
  it("blocks every non-read operation while a halt is in any state", () => {
    for (const halt of ["requested", "acknowledged", "verified_stopped"] as const) {
      denied(restart, restartContext({ halt }), "halted");
      denied(install, { now: NOW, halt, seenRequestIds: [], approval: approval() }, "halted");
    }
    const status = evaluatePrivilegedOperation(
      { requestId: "req-s", operation: "service.status", args: { service: "jarvis.service" } },
      { now: NOW, halt: "requested", seenRequestIds: [] },
    );
    assert.equal(status.allowed, true);
  });

  it("refuses a restart when the use count or restart history is not supplied", () => {
    const { grantUses: _uses, ...noUses } = restartContext();
    denied(restart, noUses, "invalid_context");
    const { grantUses: _noGrantUses, ...noGrantNoUses } = restartContext({ grant: undefined });
    denied(restart, noGrantNoUses, "invalid_context");
    const { recentRestarts: _history, ...noHistory } = restartContext();
    denied(restart, noHistory, "invalid_context");
  });

  it("counts future-dated restart attempts against the budget", () => {
    const future = Array.from({ length: RESTART_RETRY_BUDGET }, (_, index) =>
      new Date(Date.parse(NOW) + (index + 1) * 60_000).toISOString(),
    );
    denied(restart, restartContext({ recentRestarts: future }), "retry_budget_exhausted");
  });

  it("refuses a replayed request ID", () => {
    denied(restart, restartContext({ seenRequestIds: ["req-1"] }), "replayed_request");
  });

  it("fails closed on a malformed context", () => {
    denied(restart, { ...restartContext(), now: "not a time" }, "invalid_context");
    denied(
      restart,
      { ...restartContext(), halt: "maybe" } as unknown as PrivilegeContext,
      "invalid_context",
    );
  });
});
