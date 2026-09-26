import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { consultAcpPeer, type AcpPermissionRequest } from "../src/acp/acpTransport.js";
import type { AcpPermissionDecision } from "../src/acp/acpContract.js";
import { encodeAcpEnvelope } from "../src/acp/acpMessage.js";
import {
  AcpStdioTransportError,
  createBoundedLineReader,
  StdioAcpTransport,
  type AcpChildProcess,
} from "../src/acp/acpStdioTransport.js";

const REQUEST: AcpPermissionRequest = Object.freeze({
  requestId: "req-1",
  action: "merge_pull_request",
});

/** A framed response line as a worker would emit on stdout. */
function responseLine(decision: AcpPermissionDecision, requestId = "req-1"): string {
  return encodeAcpEnvelope({
    v: 1,
    kind: "permission_response",
    response: { requestId, decision },
  });
}

type ChildScript = (requestLine: string) => { lines?: string[]; close?: boolean };

/**
 * A fake worker: it reacts to the written request line on a microtask, emitting
 * scripted stdout lines and optionally closing. Records writes and whether it
 * was killed.
 */
function fakeChild(script: ChildScript): AcpChildProcess & {
  writes: string[];
  killed: () => boolean;
} {
  let onLine: ((line: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  const writes: string[] = [];
  let wasKilled = false;
  return {
    writes,
    killed: () => wasKilled,
    writeLine(line: string): void {
      writes.push(line);
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
    kill(): void {
      wasKilled = true;
    },
  };
}

/** A manually fired timeout scheduler for deterministic timeout tests. */
function manualTimer(): {
  schedule: (handler: () => void, ms: number) => () => void;
  fire: () => void;
} {
  let pending: (() => void) | undefined;
  return {
    schedule: (handler) => {
      pending = handler;
      return () => {
        pending = undefined;
      };
    },
    fire: () => pending?.(),
  };
}

describe("ACP stdio transport (PR H, slice 3)", () => {
  it("authorises only when a matching worker allow AND governed approval are present", async () => {
    const transport = new StdioAcpTransport({
      spawn: () => fakeChild(() => ({ lines: [responseLine("allow")] })),
    });
    assert.equal(
      (await consultAcpPeer({ transport, request: REQUEST, governedApprovalPresent: true }))
        .authorised,
      true,
    );
    // The very same worker allow is inert without the governed gate.
    assert.equal(
      (await consultAcpPeer({ transport, request: REQUEST, governedApprovalPresent: false }))
        .authorised,
      false,
    );
  });

  it("treats a worker deny as a veto even with governed approval present", async () => {
    const transport = new StdioAcpTransport({
      spawn: () => fakeChild(() => ({ lines: [responseLine("deny")] })),
    });
    assert.equal(
      (await consultAcpPeer({ transport, request: REQUEST, governedApprovalPresent: true }))
        .authorised,
      false,
    );
  });

  it("ignores stdout contamination and resolves the real response", async () => {
    const transport = new StdioAcpTransport({
      spawn: () =>
        fakeChild(() => ({
          lines: [
            "starting worker...",
            "{ not json",
            encodeAcpEnvelope({ v: 1, kind: "permission_request", request: REQUEST }), // wrong kind
            responseLine("allow"),
          ],
        })),
    });
    assert.equal(
      (await consultAcpPeer({ transport, request: REQUEST, governedApprovalPresent: true }))
        .authorised,
      true,
    );
  });

  it("writes the request to the worker as an encoded permission_request envelope", async () => {
    const child = fakeChild(() => ({ lines: [responseLine("abstain")] }));
    const transport = new StdioAcpTransport({ spawn: () => child });
    await consultAcpPeer({ transport, request: REQUEST, governedApprovalPresent: true });
    assert.equal(child.writes.length, 1);
    const decoded = JSON.parse(child.writes[0]!) as Record<string, unknown>;
    assert.deepEqual(decoded, {
      v: 1,
      kind: "permission_request",
      request: { requestId: "req-1", action: "merge_pull_request" },
    });
    assert.equal(child.killed(), true); // lifecycle: child is torn down after settling
  });

  describe("untrusted worker output cannot manufacture authority", () => {
    // In every case the worker "says allow" (or floods/crashes/hangs) but there
    // is NO governed approval, so authorisation must be false — the child alone
    // can never authorise.
    const expectNotAuthorised = async (deps: {
      spawn: () => AcpChildProcess;
      scheduleTimeout?: (h: () => void, ms: number) => () => void;
      fire?: () => void;
    }): Promise<void> => {
      const transport = new StdioAcpTransport({
        spawn: deps.spawn,
        maxResponseLines: 4,
        scheduleTimeout: deps.scheduleTimeout,
      });
      const pending = consultAcpPeer({
        transport,
        request: REQUEST,
        governedApprovalPresent: false,
      });
      deps.fire?.();
      assert.equal((await pending).authorised, false);
    };

    it("rejects an allow carrying a mismatched requestId", async () => {
      await expectNotAuthorised({
        spawn: () => fakeChild(() => ({ lines: [responseLine("allow", "OTHER")], close: true })),
      });
    });

    it("rejects non-JSON / fabricated allow noise", async () => {
      await expectNotAuthorised({
        spawn: () => fakeChild(() => ({ lines: ["allow", '{"decision":"allow"}'], close: true })),
      });
    });

    it("fails closed when the worker floods beyond the line bound", async () => {
      await expectNotAuthorised({
        spawn: () => fakeChild(() => ({ lines: ["a", "b", "c", "d", responseLine("allow")] })),
      });
    });

    it("fails closed when the worker crashes before responding", async () => {
      await expectNotAuthorised({ spawn: () => fakeChild(() => ({ close: true })) });
    });

    it("fails closed on timeout", async () => {
      const timer = manualTimer();
      await expectNotAuthorised({
        spawn: () => fakeChild(() => ({})), // never emits, never closes
        scheduleTimeout: timer.schedule,
        fire: timer.fire,
      });
    });
  });

  it("surfaces AcpStdioTransportError from requestPermission on crash", async () => {
    const transport = new StdioAcpTransport({ spawn: () => fakeChild(() => ({ close: true })) });
    await assert.rejects(() => transport.requestPermission(REQUEST), AcpStdioTransportError);
  });

  describe("bounded line reader (stdout memory bound)", () => {
    it("assembles complete lines across chunks", () => {
      const lines: string[] = [];
      let overflows = 0;
      const reader = createBoundedLineReader({
        maxLineBytes: 1000,
        onLine: (l) => lines.push(l),
        onOverflow: () => (overflows += 1),
      });
      reader.push("hel");
      reader.push("lo\nwor");
      reader.push("ld\n");
      assert.deepEqual(lines, ["hello", "world"]);
      assert.equal(overflows, 0);
    });

    it("overflows once on an oversized unterminated line, then ignores more input", () => {
      const lines: string[] = [];
      let overflows = 0;
      const reader = createBoundedLineReader({
        maxLineBytes: 8,
        onLine: (l) => lines.push(l),
        onOverflow: () => (overflows += 1),
      });
      reader.push("123456789012345"); // 15 bytes, no newline
      assert.equal(overflows, 1);
      assert.deepEqual(lines, []);
      reader.push("more\n"); // ignored after overflow
      assert.equal(overflows, 1);
      assert.deepEqual(lines, []);
    });

    it("overflows on an oversized completed line", () => {
      const lines: string[] = [];
      let overflows = 0;
      const reader = createBoundedLineReader({
        maxLineBytes: 4,
        onLine: (l) => lines.push(l),
        onOverflow: () => (overflows += 1),
      });
      reader.push("toolongline\n");
      assert.equal(overflows, 1);
      assert.deepEqual(lines, []);
    });
  });
});
