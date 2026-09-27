/**
 * Nolan ACP worker adapter core (roadmap PR H — governed commissioning slice).
 *
 * The smallest possible ACP *reviewer*: it receives a validated
 * {@link AcpPermissionRequest} envelope on stdin, produces exactly one of
 * `allow` / `deny` / `abstain`, and emits a {@link AcpPermissionResponse}
 * envelope on stdout. It is **not** a second Nolan. Its *authority* limits are
 * structural (this is all the code there is): its only output is one advisory
 * decision, so it cannot approve ToolActions, merge, deploy, call MCP tools, or
 * manufacture ACP authority — the governed gate treats its `allow` as
 * non-authoritative regardless. Its *process* limits (no repo/credential reads,
 * no shell, no network, no external effect) are NOT provided by this code — they
 * depend on the host sandbox (see `docs/operations/acp-worker-sandbox.md`); do
 * not treat them as guaranteed until that sandbox is verified.
 *
 * Fail-safe by construction: on a malformed request, or if the decider throws or
 * returns an invalid value, the worker emits **nothing**. It never fabricates an
 * `allow` or `abstain` on error — a silent worker is seen by the transport as a
 * crash/timeout, which the governed `required` mode treats fail-closed (block).
 *
 * What is deliberately NOT here: a live, model-backed {@link AcpDecider}. Calling
 * a real model needs the worker's own API credential and a governed egress path
 * — a host-commissioning concern (Gate D), provisioned out of band and injected
 * as the `decide` function. This module ships only the protocol shell plus a
 * deterministic decider for offline/fake-worker commissioning (Gate B).
 */

import { StringDecoder } from "node:string_decoder";

import type { AcpPermissionDecision, AcpPermissionResponse } from "./acpContract.js";
import { decodeAcpEnvelope, encodeAcpEnvelope } from "./acpMessage.js";
import { createBoundedLineReader, DEFAULT_ACP_STDIO_MAX_LINE_BYTES } from "./acpStdioTransport.js";
import type { AcpPermissionRequest } from "./acpTransport.js";

/** Maps a validated request to one advisory decision. May be async (a model call). */
export type AcpDecider = (
  request: AcpPermissionRequest,
) => AcpPermissionDecision | Promise<AcpPermissionDecision>;

const VALID_DECISIONS: ReadonlySet<AcpPermissionDecision> = new Set(["allow", "deny", "abstain"]);

/**
 * Handle one inbound wire line. Returns the encoded response line to emit, or
 * `null` to emit nothing (malformed request, non-request frame, decider throw,
 * or an invalid decision). Never throws.
 */
export async function handleAcpRequestLine(
  line: string,
  decide: AcpDecider,
): Promise<string | null> {
  const envelope = decodeAcpEnvelope(line);
  if (!envelope || envelope.kind !== "permission_request") return null;
  let decision: AcpPermissionDecision;
  try {
    decision = await decide(envelope.request);
  } catch {
    return null;
  }
  if (!VALID_DECISIONS.has(decision)) return null;
  const response: AcpPermissionResponse = {
    requestId: envelope.request.requestId,
    decision,
  };
  return encodeAcpEnvelope({ v: 1, kind: "permission_response", response });
}

/** A deterministic decider that always returns the same decision (Gate-B fake worker). */
export function staticDecider(decision: AcpPermissionDecision): AcpDecider {
  return () => decision;
}

export type RunAcpWorkerOptions = Readonly<{
  /** Async iterable / stream of stdin chunks (strings or Buffers). */
  input: AsyncIterable<string | Uint8Array>;
  /** Sink for encoded response lines (a trailing newline is appended). */
  write: (line: string) => void;
  decide: AcpDecider;
  maxLineBytes?: number;
}>;

/**
 * Drive the worker over a stdin stream: for each complete newline-delimited line,
 * emit a response line when {@link handleAcpRequestLine} produces one. Bounded by
 * {@link createBoundedLineReader} so an oversized line stops processing rather
 * than growing memory. Suitable as the body of a `nolan-acp-worker` executable.
 */
export async function runAcpWorker(options: RunAcpWorkerOptions): Promise<void> {
  const pending: string[] = [];
  let overflowed = false;
  const reader = createBoundedLineReader({
    maxLineBytes: options.maxLineBytes ?? DEFAULT_ACP_STDIO_MAX_LINE_BYTES,
    onLine: (line) => pending.push(line),
    onOverflow: () => {
      overflowed = true;
    },
  });
  // Incremental UTF-8 decoder: a multibyte character split across two byte
  // chunks is buffered and completed on the next write, rather than being
  // decoded (and corrupted) per chunk. EVERY chunk goes through the one decoder
  // — a string chunk is re-encoded to UTF-8 bytes first — so a byte chunk that
  // ends mid-code-point still combines correctly with a following string chunk,
  // rather than the buffered bytes being stranded.
  const decoder = new StringDecoder("utf8");
  for await (const chunk of options.input) {
    reader.push(
      decoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk)),
    );
    while (pending.length > 0) {
      const line = pending.shift()!;
      const response = await handleAcpRequestLine(line, options.decide);
      if (response !== null) options.write(`${response}\n`);
    }
    if (overflowed) return;
  }
}
