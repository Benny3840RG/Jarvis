import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { decodeAcpEnvelope, encodeAcpEnvelope } from "../src/acp/acpMessage.js";
import {
  handleAcpRequestLine,
  runAcpWorker,
  staticDecider,
  type AcpDecider,
} from "../src/acp/nolanAcpWorker.js";
import { spawnAcpChild, StdioAcpTransport } from "../src/acp/acpStdioTransport.js";
import type { AcpPermissionRequest } from "../src/acp/acpTransport.js";

const REQUEST: AcpPermissionRequest = Object.freeze({
  requestId: "req-1",
  action: "github:merge-pull-request",
});

function requestLine(request: AcpPermissionRequest = REQUEST): string {
  return encodeAcpEnvelope({ v: 1, kind: "permission_request", request });
}

describe("handleAcpRequestLine", () => {
  it("emits a matching response for each valid decision", async () => {
    for (const d of ["allow", "deny", "abstain"] as const) {
      const out = await handleAcpRequestLine(requestLine(), staticDecider(d));
      assert.notEqual(out, null);
      const decoded = decodeAcpEnvelope(out!);
      assert.equal(decoded?.kind, "permission_response");
      assert.equal(decoded?.kind === "permission_response" && decoded.response.decision, d);
      assert.equal(decoded?.kind === "permission_response" && decoded.response.requestId, "req-1");
    }
  });

  it("emits nothing for a non-request frame or malformed line", async () => {
    const responseFrame = encodeAcpEnvelope({
      v: 1,
      kind: "permission_response",
      response: { requestId: "req-1", decision: "allow" },
    });
    assert.equal(await handleAcpRequestLine(responseFrame, staticDecider("allow")), null);
    assert.equal(await handleAcpRequestLine("not json", staticDecider("allow")), null);
    assert.equal(await handleAcpRequestLine("{}", staticDecider("allow")), null);
  });

  it("emits nothing when the decider throws (never fabricates a decision)", async () => {
    const thrower: AcpDecider = () => {
      throw new Error("model unreachable");
    };
    assert.equal(await handleAcpRequestLine(requestLine(), thrower), null);
  });

  it("emits nothing when the decider returns an invalid value", async () => {
    const bogus = (() => "maybe") as unknown as AcpDecider;
    assert.equal(await handleAcpRequestLine(requestLine(), bogus), null);
  });
});

describe("runAcpWorker", () => {
  it("responds to each request line from the input stream", async () => {
    const written: string[] = [];
    async function* input(): AsyncIterable<string> {
      yield `${requestLine({ requestId: "a", action: "x" })}\n`;
      yield `${requestLine({ requestId: "b", action: "y" })}\n`;
    }
    await runAcpWorker({
      input: input(),
      write: (l) => written.push(l),
      decide: staticDecider("deny"),
    });
    assert.equal(written.length, 2);
    const ids = written.map((l) => {
      const d = decodeAcpEnvelope(l.trim());
      return d?.kind === "permission_response" ? d.response.requestId : "";
    });
    assert.deepEqual(ids, ["a", "b"]);
  });

  it("stops on an oversized line without emitting a response", async () => {
    const written: string[] = [];
    async function* input(): AsyncIterable<string> {
      yield "x".repeat(100) + "\n"; // no newline within the tiny bound below → overflow
    }
    await runAcpWorker({
      input: input(),
      write: (l) => written.push(l),
      decide: staticDecider("allow"),
      maxLineBytes: 8,
    });
    assert.deepEqual(written, []);
  });

  it("preserves a multibyte character split across input byte chunks", async () => {
    const request: AcpPermissionRequest = { requestId: "req-1", action: "café:announce–now" };
    const line = `${requestLine(request)}\n`;
    const bytes = Buffer.from(line, "utf8");
    // Split at a byte index that lands inside a multibyte sequence (é / – are
    // multibyte); decoding each half independently would corrupt it.
    const cut = 6;
    const chunks = [bytes.subarray(0, cut), bytes.subarray(cut)];
    async function* input(): AsyncIterable<Uint8Array> {
      for (const c of chunks) yield c;
    }
    let seen: string | undefined;
    await runAcpWorker({
      input: input(),
      write: () => {},
      decide: (req) => {
        seen = req.action;
        return "abstain";
      },
    });
    assert.equal(seen, "café:announce–now");
  });
});

describe("nolan-acp-worker as a real subprocess (Gate-B live stdio path)", () => {
  const fixture = fileURLToPath(new URL("./fixtures/acpWorkerFixture.ts", import.meta.url));

  const transportFor = (decision: string, timeoutMs = 15_000): StdioAcpTransport =>
    new StdioAcpTransport({
      spawn: () =>
        spawnAcpChild({
          command: process.execPath,
          args: ["--import", "tsx", fixture, decision],
        }),
      timeoutMs,
    });

  it("resolves a real worker's allow decision over spawned stdio", async () => {
    const response = await transportFor("allow").requestPermission(REQUEST);
    assert.equal(response.decision, "allow");
    assert.equal(response.requestId, "req-1");
  });

  it("resolves a real worker's deny decision over spawned stdio", async () => {
    const response = await transportFor("deny").requestPermission(REQUEST);
    assert.equal(response.decision, "deny");
  });

  it("rejects fail-closed when the real worker stays silent (timeout, no response)", async () => {
    await assert.rejects(() => transportFor("silent", 2_000).requestPermission(REQUEST));
  });
});
