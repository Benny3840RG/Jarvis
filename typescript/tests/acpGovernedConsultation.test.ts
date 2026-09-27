import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyAcpConsultation,
  createGovernedAcpConsultationFromEnv,
} from "../src/acp/acpGovernedConsultation.js";
import type { AcpPermissionDecision } from "../src/acp/acpContract.js";
import { encodeAcpEnvelope } from "../src/acp/acpMessage.js";
import { AcpStdioTransportError, type AcpChildProcess } from "../src/acp/acpStdioTransport.js";
import type { AcpPermissionRequest, AcpTransport } from "../src/acp/acpTransport.js";

const REQUEST: AcpPermissionRequest = Object.freeze({
  requestId: "req-1",
  action: "github:merge-pull-request",
});

const CONFIGURED = {
  JARVIS_ACP_WORKER_COMMAND: "claude",
  JARVIS_ACP_WORKER_ARGS: '["acp","--stdio"]',
} as const;

function responseLine(decision: AcpPermissionDecision, requestId = "req-1"): string {
  return encodeAcpEnvelope({
    v: 1,
    kind: "permission_response",
    response: { requestId, decision },
  });
}

type ChildScript = (line: string) => { lines?: string[]; close?: boolean };

function fakeChild(script: ChildScript): AcpChildProcess {
  let onLine: ((line: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  return {
    writeLine(line: string): void {
      queueMicrotask(() => {
        const { lines = [], close = false } = script(line);
        for (const l of lines) onLine?.(l);
        if (close) onClose?.();
      });
    },
    onStdoutLine(handler: (line: string) => void): void {
      onLine = handler;
    },
    onClose(handler: () => void): void {
      onClose = handler;
    },
    kill(): void {},
  };
}

// A transport that resolves/rejects with a fixed value, for classification tests.
function fixedTransport(behaviour: () => Promise<unknown>): AcpTransport {
  return { requestPermission: () => behaviour() as Promise<never> };
}

describe("classifyAcpConsultation", () => {
  it("returns the decision for a valid matching response", async () => {
    for (const d of ["allow", "deny", "abstain"] as const) {
      const c = await classifyAcpConsultation(
        fixedTransport(async () => ({ requestId: "req-1", decision: d })),
        REQUEST,
      );
      assert.equal(c, d);
    }
  });

  it("classifies a mismatched requestId as request_mismatch", async () => {
    const c = await classifyAcpConsultation(
      fixedTransport(async () => ({ requestId: "WRONG", decision: "allow" })),
      REQUEST,
    );
    assert.equal(c, "request_mismatch");
  });

  it("classifies a non-object / unknown-decision answer as malformed_response", async () => {
    assert.equal(
      await classifyAcpConsultation(
        fixedTransport(async () => "nope"),
        REQUEST,
      ),
      "malformed_response",
    );
    assert.equal(
      await classifyAcpConsultation(
        fixedTransport(async () => ({ requestId: "req-1", decision: "maybe" })),
        REQUEST,
      ),
      "malformed_response",
    );
  });

  it("classifies a hostile throwing-getter object as malformed_response", async () => {
    const hostile = {
      get requestId(): string {
        throw new Error("boom");
      },
    };
    const c = await classifyAcpConsultation(
      fixedTransport(async () => hostile),
      REQUEST,
    );
    assert.equal(c, "malformed_response");
  });

  it("maps AcpStdioTransportError codes to failure classifications", async () => {
    const cases: Array<[ConstructorParameters<typeof AcpStdioTransportError>[0], string]> = [
      ["timeout", "timeout"],
      ["worker_crash", "worker_crash"],
      ["output_limit_exceeded", "output_limit_exceeded"],
      ["write_failed", "internal_transport_error"],
    ];
    for (const [code, expected] of cases) {
      const c = await classifyAcpConsultation(
        fixedTransport(async () => {
          throw new AcpStdioTransportError(code, "x");
        }),
        REQUEST,
      );
      assert.equal(c, expected);
    }
  });

  it("classifies an unclassifiable throw as internal_transport_error (per the taxonomy)", async () => {
    const c = await classifyAcpConsultation(
      fixedTransport(async () => {
        throw new Error("unexpected");
      }),
      REQUEST,
    );
    assert.equal(c, "internal_transport_error");
  });
});

describe("createGovernedAcpConsultationFromEnv — dormancy", () => {
  it("disabled by default: never consults, never spawns, governed decision stands", async () => {
    let spawned = 0;
    const consultation = createGovernedAcpConsultationFromEnv({
      environment: CONFIGURED, // worker configured, but mode unset ⇒ disabled
      spawnChild: () => {
        spawned += 1;
        return fakeChild(() => ({ lines: [responseLine("deny")] }));
      },
    });
    assert.equal(consultation.mode, "disabled");
    const approved = await consultation.consult(REQUEST, true);
    assert.equal(approved.proceed, true);
    assert.equal(approved.consulted, false);
    const unapproved = await consultation.consult(REQUEST, false);
    assert.equal(unapproved.proceed, false);
    assert.equal(spawned, 0, "disabled mode must never launch a worker");
  });

  it("active mode blocks an unapproved action WITHOUT consulting (ACP cannot grant authority)", async () => {
    let spawned = 0;
    for (const mode of ["advisory", "required"] as const) {
      const consultation = createGovernedAcpConsultationFromEnv({
        mode,
        environment: CONFIGURED,
        spawnChild: () => {
          spawned += 1;
          return fakeChild(() => ({ lines: [responseLine("allow")] }));
        },
      });
      const out = await consultation.consult(REQUEST, false);
      assert.equal(out.proceed, false, `${mode} + no governed must block`);
      assert.equal(out.consulted, false);
    }
    assert.equal(spawned, 0, "no worker launches for an unauthorised action");
  });

  it("active mode + governed approval + no worker configured ⇒ unavailable", async () => {
    const advisory = createGovernedAcpConsultationFromEnv({ mode: "advisory", environment: {} });
    const a = await advisory.consult(REQUEST, true);
    assert.equal(a.classification, "unavailable");
    assert.equal(a.proceed, true, "advisory proceeds on unavailable with governed approval");

    const required = createGovernedAcpConsultationFromEnv({ mode: "required", environment: {} });
    const r = await required.consult(REQUEST, true);
    assert.equal(r.classification, "unavailable");
    assert.equal(r.proceed, false, "required blocks on unavailable");
  });
});

describe("createGovernedAcpConsultationFromEnv — advisory (evidence only)", () => {
  const advisoryWith = (
    script: ChildScript,
  ): ReturnType<typeof createGovernedAcpConsultationFromEnv> =>
    createGovernedAcpConsultationFromEnv({
      mode: "advisory",
      environment: CONFIGURED,
      spawnChild: () => fakeChild(script),
    });

  it("proceeds on allow/abstain with governed approval", async () => {
    for (const d of ["allow", "abstain"] as const) {
      const out = await advisoryWith(() => ({ lines: [responseLine(d)] })).consult(REQUEST, true);
      assert.equal(out.proceed, true);
      assert.equal(out.classification, d);
      assert.equal(out.disagreement, false);
    }
  });

  it("proceeds on deny but records a disagreement", async () => {
    const out = await advisoryWith(() => ({ lines: [responseLine("deny")] })).consult(
      REQUEST,
      true,
    );
    assert.equal(out.proceed, true);
    assert.equal(out.classification, "deny");
    assert.equal(out.disagreement, true);
  });

  it("proceeds and records the failure class on crash/flood", async () => {
    const crash = await advisoryWith(() => ({ close: true })).consult(REQUEST, true);
    assert.equal(crash.proceed, true);
    assert.equal(crash.classification, "worker_crash");

    const mismatch = await advisoryWith(() => ({
      lines: [responseLine("allow", "WRONG")],
      close: true,
    })).consult(REQUEST, true);
    assert.equal(mismatch.proceed, true);
    // A mismatched line is ignored as contamination; the close then yields worker_crash.
    assert.equal(mismatch.classification, "worker_crash");
  });
});

describe("createGovernedAcpConsultationFromEnv — required (veto/failure gate)", () => {
  const requiredWith = (
    script: ChildScript,
  ): ReturnType<typeof createGovernedAcpConsultationFromEnv> =>
    createGovernedAcpConsultationFromEnv({
      mode: "required",
      environment: CONFIGURED,
      spawnChild: () => fakeChild(script),
    });

  it("proceeds only on allow/abstain with governed approval", async () => {
    for (const d of ["allow", "abstain"] as const) {
      const out = await requiredWith(() => ({ lines: [responseLine(d)] })).consult(REQUEST, true);
      assert.equal(out.proceed, true, `required + ${d} + governed proceeds`);
    }
  });

  it("blocks on deny and on crash even with governed approval", async () => {
    const deny = await requiredWith(() => ({ lines: [responseLine("deny")] })).consult(
      REQUEST,
      true,
    );
    assert.equal(deny.proceed, false);
    assert.equal(deny.classification, "deny");

    const crash = await requiredWith(() => ({ close: true })).consult(REQUEST, true);
    assert.equal(crash.proceed, false);
    assert.equal(crash.classification, "worker_crash");
  });

  it("records latency and correlation from the request detail", async () => {
    let t = 1000;
    const consultation = createGovernedAcpConsultationFromEnv({
      mode: "required",
      environment: CONFIGURED,
      spawnChild: () => fakeChild(() => ({ lines: [responseLine("allow")] })),
      now: () => (t += 5),
    });
    const out = await consultation.consult(
      { requestId: "req-1", action: "github:merge-pull-request", detail: "corr-9" },
      true,
    );
    assert.equal(out.correlationId, "corr-9");
    assert.equal(typeof out.latencyMs, "number");
    assert.equal(out.latencyMs! >= 0, true);
  });
});
