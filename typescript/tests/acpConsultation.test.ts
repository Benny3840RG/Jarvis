import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAcpConsultationFromEnv } from "../src/acp/acpConsultation.js";
import type { AcpPermissionRequest } from "../src/acp/acpTransport.js";
import type { AcpPermissionDecision } from "../src/acp/acpContract.js";
import { encodeAcpEnvelope } from "../src/acp/acpMessage.js";
import type { AcpChildProcess } from "../src/acp/acpStdioTransport.js";

const REQUEST: AcpPermissionRequest = Object.freeze({
  requestId: "req-1",
  action: "merge_pull_request",
});

const CONFIGURED_ENV = {
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

type ChildScript = (requestLine: string) => { lines?: string[]; close?: boolean };

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

describe("ACP consultation wiring (PR H, slice 6 — dormant-first live path)", () => {
  it("is disabled when no worker is configured and launches nothing", async () => {
    let spawned = 0;
    const consultation = createAcpConsultationFromEnv({
      environment: {},
      spawnChild: () => {
        spawned += 1;
        return fakeChild(() => ({}));
      },
    });
    assert.equal(consultation.enabled, false);
    // Advisory overlay disabled → governed approval alone decides; nothing spawned.
    assert.equal((await consultation.consult(REQUEST, true)).authorised, true);
    assert.equal((await consultation.consult(REQUEST, false)).authorised, false);
    assert.equal(spawned, 0);
  });

  it("blocks when unconfigured but a configured peer is required (mandatory ACP)", async () => {
    const consultation = createAcpConsultationFromEnv({
      environment: {},
      requireConfiguredPeer: true,
      spawnChild: () => fakeChild(() => ({})),
    });
    assert.equal(consultation.enabled, false);
    // Even with governed approval, mandatory-but-absent ACP fails closed.
    assert.equal((await consultation.consult(REQUEST, true)).authorised, false);
  });

  it("does not launch a worker until consult() is actually called (dormant)", async () => {
    let spawned = 0;
    const consultation = createAcpConsultationFromEnv({
      environment: CONFIGURED_ENV,
      spawnChild: () => {
        spawned += 1;
        return fakeChild(() => ({ lines: [responseLine("abstain")] }));
      },
    });
    assert.equal(consultation.enabled, true);
    assert.equal(spawned, 0, "construction must not spawn");
    await consultation.consult(REQUEST, true);
    assert.equal(spawned, 1, "consult() spawns the worker");
  });

  it("passes the resolved worker config to the spawner", async () => {
    let seen: { command: string; args: readonly string[] } | undefined;
    const consultation = createAcpConsultationFromEnv({
      environment: CONFIGURED_ENV,
      spawnChild: (config) => {
        seen = config;
        return fakeChild(() => ({ lines: [responseLine("allow")] }));
      },
    });
    await consultation.consult(REQUEST, true);
    assert.deepEqual(seen, { command: "claude", args: ["acp", "--stdio"] });
  });

  it("authorises a configured peer's allow only with governed approval", async () => {
    const make = (): ReturnType<typeof createAcpConsultationFromEnv> =>
      createAcpConsultationFromEnv({
        environment: CONFIGURED_ENV,
        spawnChild: () => fakeChild(() => ({ lines: [responseLine("allow")] })),
      });
    assert.equal((await make().consult(REQUEST, true)).authorised, true);
    assert.equal((await make().consult(REQUEST, false)).authorised, false);
  });

  it("treats a configured peer's deny as a veto even with governed approval", async () => {
    const consultation = createAcpConsultationFromEnv({
      environment: CONFIGURED_ENV,
      spawnChild: () => fakeChild(() => ({ lines: [responseLine("deny")] })),
    });
    assert.equal((await consultation.consult(REQUEST, true)).authorised, false);
  });

  it("blocks fail-closed when the configured worker crashes — even with governed approval", async () => {
    const consultation = createAcpConsultationFromEnv({
      environment: CONFIGURED_ENV,
      spawnChild: () => fakeChild(() => ({ close: true })), // no response, then closes
    });
    assert.equal((await consultation.consult(REQUEST, true)).authorised, false);
  });

  it("blocks fail-closed on a malformed/mismatched worker answer with governed approval", async () => {
    const consultation = createAcpConsultationFromEnv({
      environment: CONFIGURED_ENV,
      spawnChild: () => fakeChild(() => ({ lines: [responseLine("allow", "WRONG")], close: true })),
    });
    assert.equal((await consultation.consult(REQUEST, true)).authorised, false);
  });
});
