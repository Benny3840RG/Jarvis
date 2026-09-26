/**
 * ACP stdio transport (roadmap PR H, slice 3).
 *
 * The first concrete {@link AcpTransport}: it carries an ACP permission
 * request/response to a locally launched worker (Claude/Codex) over the
 * worker's stdin/stdout, using the wire framing from {@link acpMessage}. It is
 * **networkless** — no HTTP, no listeners, no ports, no egress path. (The
 * worker's own model/API access is a separate governed-egress concern and is
 * deliberately untouched here; this slice neither grants nor broadens it.)
 *
 * AUTH-INV-05 is preserved exactly, and the transport is fail-closed by
 * construction: `requestPermission` only ever resolves with a response it
 * decoded via {@link decodeAcpEnvelope} *and* whose kind is `permission_response`
 * *and* whose `requestId` matches the request. Anything else — malformed or
 * non-JSON output, a mismatched id, a flood of noise beyond the line bound, a
 * timeout, or the child crashing/closing before a valid response — rejects. A
 * rejection (or any thrown error) is turned into `abstain` by
 * {@link consultAcpPeer}, so untrusted child output can never manufacture an
 * `allow`: on its own a peer `allow` is advisory and still requires an
 * independent governed approval, and `deny` remains a veto.
 *
 * stdout is the framing channel; the real spawner keeps the child's stderr
 * separate so ordinary logging cannot contaminate the frames. Even so, every
 * stdout line is validated, so interleaved noise is simply ignored.
 */

import { spawn as nodeSpawn } from "node:child_process";

import type { AcpPermissionResponse } from "./acpContract.js";
import { decodeAcpEnvelope, encodeAcpEnvelope } from "./acpMessage.js";
import type { AcpPermissionRequest, AcpTransport } from "./acpTransport.js";

/** Default upper bound on how long to await a worker's response (ms). */
export const DEFAULT_ACP_STDIO_TIMEOUT_MS = 30_000;
/** Default cap on stdout lines read before giving up (bounds a noisy/hostile child). */
export const DEFAULT_ACP_STDIO_MAX_LINES = 1000;
/**
 * Default cap on the bytes of a single stdout line (bounds a hostile child that
 * emits an arbitrarily long unterminated line to exhaust memory).
 */
export const DEFAULT_ACP_STDIO_MAX_LINE_BYTES = 65_536;

export class AcpStdioTransportError extends Error {
  constructor(reason: string) {
    super(`ACP stdio transport failed: ${reason}`);
    this.name = "AcpStdioTransportError";
  }
}

/**
 * The minimal child-process surface the transport drives. A real worker is
 * wrapped by {@link spawnAcpChild}; tests supply a fake. Handlers are registered
 * before the request is written, so no output is missed.
 */
export interface AcpChildProcess {
  /** Write one framed line to the child's stdin. */
  writeLine(line: string): void;
  /** Register the handler for each stdout line. */
  onStdoutLine(handler: (line: string) => void): void;
  /** Register the handler for the child closing (normal exit or error). */
  onClose(handler: () => void): void;
  /** Terminate the child and release resources. */
  kill(): void;
}

export type StdioAcpTransportDeps = Readonly<{
  spawn: () => AcpChildProcess;
  timeoutMs?: number;
  maxResponseLines?: number;
  /** Schedule a fail-closed timeout; returns a cancel fn. Injectable for tests. */
  scheduleTimeout?: (handler: () => void, ms: number) => () => void;
}>;

function defaultScheduleTimeout(handler: () => void, ms: number): () => void {
  const timer = setTimeout(handler, ms);
  // Don't keep the event loop alive on the timeout alone.
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

/**
 * An {@link AcpTransport} that consults a locally launched worker over stdio.
 * Spawns a fresh child per request (so a crash fails only that request and the
 * next request starts clean), writes the framed request, and resolves with the
 * first valid matching response — or rejects fail-closed.
 */
export class StdioAcpTransport implements AcpTransport {
  readonly #spawn: () => AcpChildProcess;
  readonly #timeoutMs: number;
  readonly #maxResponseLines: number;
  readonly #scheduleTimeout: (handler: () => void, ms: number) => () => void;

  constructor(deps: StdioAcpTransportDeps) {
    this.#spawn = deps.spawn;
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_ACP_STDIO_TIMEOUT_MS;
    this.#maxResponseLines = deps.maxResponseLines ?? DEFAULT_ACP_STDIO_MAX_LINES;
    this.#scheduleTimeout = deps.scheduleTimeout ?? defaultScheduleTimeout;
  }

  requestPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    const child = this.#spawn();
    return new Promise<AcpPermissionResponse>((resolve, reject) => {
      let settled = false;
      let lines = 0;
      let cancelTimeout: () => void = () => {};

      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        try {
          child.kill();
        } catch {
          // Best-effort teardown; a kill failure must not mask the outcome.
        }
        finish();
      };
      const fail = (reason: string): void =>
        settle(() => reject(new AcpStdioTransportError(reason)));

      child.onStdoutLine((line) => {
        if (settled) return;
        lines += 1;
        const envelope = decodeAcpEnvelope(line);
        if (
          envelope?.kind === "permission_response" &&
          envelope.response.requestId === request.requestId
        ) {
          settle(() => resolve(envelope.response));
          return;
        }
        // Non-matching line: ignore as contamination, but bound how much we read.
        if (lines >= this.#maxResponseLines) {
          fail("no valid response within the bounded stdout window");
        }
      });
      child.onClose(() => {
        if (!settled) fail("worker closed before returning a valid response");
      });
      cancelTimeout = this.#scheduleTimeout(
        () => fail("timed out awaiting a worker response"),
        this.#timeoutMs,
      );

      try {
        child.writeLine(encodeAcpEnvelope({ v: 1, kind: "permission_request", request }));
      } catch {
        fail("failed to write the request to the worker");
      }
    });
  }
}

/**
 * A byte-bounded, newline-delimited line reader. Feed it stdout chunks; it emits
 * complete lines via `onLine`. If a single line (complete or the still-pending
 * un-terminated tail) exceeds `maxLineBytes`, it calls `onOverflow` exactly once
 * and stops — so a worker cannot exhaust memory with one arbitrarily long,
 * newline-less line (which a completed-line count alone would never bound).
 * Pure and synchronous, so it is unit-tested directly.
 */
export function createBoundedLineReader(options: {
  maxLineBytes: number;
  onLine: (line: string) => void;
  onOverflow: () => void;
}): { push: (chunk: string) => void } {
  let buffer = "";
  let overflowed = false;
  const overflow = (): void => {
    overflowed = true;
    buffer = "";
    options.onOverflow();
  };
  return {
    push(chunk: string): void {
      if (overflowed) return;
      buffer += chunk;
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          if (Buffer.byteLength(buffer, "utf8") > options.maxLineBytes) overflow();
          return;
        }
        const line = buffer.slice(0, newlineIndex);
        if (Buffer.byteLength(line, "utf8") > options.maxLineBytes) {
          overflow();
          return;
        }
        buffer = buffer.slice(newlineIndex + 1);
        options.onLine(line);
        if (overflowed) return;
      }
    },
  };
}

/**
 * Spawn a real local worker as an {@link AcpChildProcess} over stdio. stdin/stdout
 * are piped for the ACP frames; stderr is inherited so the worker's own logging
 * never contaminates the stdout framing channel. stdout is read through a
 * {@link createBoundedLineReader}, so an oversized unterminated line terminates
 * the child (fail-closed) instead of growing memory. This is the live adapter
 * (like PR F's live wiring): it is not exercised by the offline tests, which
 * drive {@link StdioAcpTransport} through a fake child. No network is opened here.
 */
export function spawnAcpChild(options: {
  command: string;
  args?: readonly string[];
  maxLineBytes?: number;
}): AcpChildProcess {
  const child = nodeSpawn(options.command, options.args ? [...options.args] : [], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let lineHandler: ((line: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let closed = false;
  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    closeHandler?.();
  };
  const reader = createBoundedLineReader({
    maxLineBytes: options.maxLineBytes ?? DEFAULT_ACP_STDIO_MAX_LINE_BYTES,
    onLine: (line) => lineHandler?.(line),
    onOverflow: () => {
      try {
        child.kill();
      } catch {
        // Best-effort; the close below still fails the request closed.
      }
      fireClose();
    },
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => reader.push(chunk));
  child.on("close", fireClose);
  child.on("error", fireClose);
  return {
    writeLine(line: string): void {
      child.stdin?.write(`${line}\n`);
    },
    onStdoutLine(handler: (line: string) => void): void {
      lineHandler = handler;
    },
    onClose(handler: () => void): void {
      closeHandler = handler;
    },
    kill(): void {
      try {
        child.kill();
      } catch {
        // Best-effort teardown.
      }
    },
  };
}
