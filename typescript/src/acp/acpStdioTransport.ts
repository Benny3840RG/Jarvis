/**
 * ACP stdio transport (roadmap PR H, slice 3).
 *
 * The first concrete {@link AcpTransport}: it carries an ACP permission
 * request/response to a locally launched worker (Claude/Codex) over the
 * worker's stdin/stdout, using the wire framing from {@link acpMessage}. The
 * transport itself opens no network — no HTTP, no listeners, no ports. It does
 * *not* by itself make the child networkless: keeping the worker off the
 * network, and governing its own model/API egress, is a host/provisioning
 * concern (see {@link spawnAcpChild}); this slice neither grants nor broadens
 * that egress, and passes the child a minimal, credential-free environment.
 *
 * AUTH-INV-05 is preserved exactly, and the transport is fail-closed by
 * construction: `requestPermission` only ever resolves with a response it
 * decoded via {@link decodeAcpEnvelope} *and* whose kind is `permission_response`
 * *and* whose `requestId` matches the request. Anything else — malformed or
 * non-JSON output, a mismatched id, a flood of noise beyond the line bound, a
 * timeout, or the child crashing/closing before a valid response — rejects. A
 * rejection is treated by {@link consultAcpPeer} as an **indeterminate**
 * consultation and resolves to *not authorised even with a governed approval*,
 * so untrusted child output can neither manufacture an `allow` nor suppress a
 * veto. Only an explicit `abstain` from a reachable peer defers to the governed
 * decision.
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

/**
 * How to launch a local ACP worker: the executable and its literal argv. Args
 * are passed to `child_process.spawn` with no shell, so each element is one
 * argument (no shell interpretation). Resolved fail-closed from the environment
 * by `resolveAcpWorkerConfigFromEnv`.
 */
export type AcpWorkerConfig = Readonly<{ command: string; args: readonly string[] }>;

/**
 * Why a stdio consultation failed. A precise, non-secret classification so the
 * governed consultation layer can record operational evidence rather than
 * sniffing the human-readable message. `write_failed` is a transport-internal
 * fault (we never handed the request to the worker).
 */
export type AcpStdioTransportFailureCode =
  "timeout" | "worker_crash" | "output_limit_exceeded" | "write_failed" | "request_mismatch";

export class AcpStdioTransportError extends Error {
  readonly code: AcpStdioTransportFailureCode;

  constructor(code: AcpStdioTransportFailureCode, reason: string) {
    super(`ACP stdio transport failed: ${reason}`);
    this.name = "AcpStdioTransportError";
    this.code = code;
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
  /**
   * Register the handler for the child closing (normal exit or error). A
   * `reason` is supplied when the close was forced for a classifiable cause
   * (e.g. `output_limit_exceeded` on an oversized line) so the transport can
   * record accurate evidence instead of a generic crash; a plain close passes
   * none.
   */
  onClose(handler: (reason?: AcpStdioTransportFailureCode) => void): void;
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
      const fail = (code: AcpStdioTransportFailureCode, reason: string): void =>
        settle(() => reject(new AcpStdioTransportError(code, reason)));

      child.onStdoutLine((line) => {
        if (settled) return;
        lines += 1;
        const envelope = decodeAcpEnvelope(line);
        if (envelope?.kind === "permission_response") {
          if (envelope.response.requestId === request.requestId) {
            settle(() => resolve(envelope.response));
            return;
          }
          // A well-formed response for a *different* requestId is a genuine
          // mismatch, not log contamination: we spawn a fresh child per request
          // and send exactly one id, so the worker answered the wrong request.
          // Surface it as request_mismatch rather than ignoring it.
          fail("request_mismatch", "worker responded with a mismatched requestId");
          return;
        }
        // A non-frame line (unrelated stdout / a line that does not decode to a
        // response) is treated as contamination and ignored — stderr is the
        // worker's log channel — but bounded so a flood cannot stall the request.
        // (A malformed frame is indistinguishable from stray output here, so it
        // is not surfaced as malformed_response; that classification comes from
        // the strict in-process transport. See acpGovernedConsultation.ts.)
        if (lines >= this.#maxResponseLines) {
          fail("output_limit_exceeded", "no valid response within the bounded stdout window");
        }
      });
      child.onClose((reason) => {
        if (settled) return;
        if (reason === "output_limit_exceeded") {
          fail("output_limit_exceeded", "worker exceeded the stdout byte bound");
        } else {
          fail("worker_crash", "worker closed before returning a valid response");
        }
      });
      cancelTimeout = this.#scheduleTimeout(
        () => fail("timeout", "timed out awaiting a worker response"),
        this.#timeoutMs,
      );

      try {
        child.writeLine(encodeAcpEnvelope({ v: 1, kind: "permission_request", request }));
      } catch {
        fail("write_failed", "failed to write the request to the worker");
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
 * Build a **minimal, allowlisted** environment for a worker child. Jarvis's own
 * `process.env` (which may hold credentials/tokens) is deliberately *not*
 * inherited: the child starts from only `PATH` (so the command resolves) plus
 * the caller's explicit `overrides`. This keeps Jarvis credentials out of the
 * worker. Pure and testable.
 */
export function buildAcpChildEnv(
  overrides: Readonly<Record<string, string>> = {},
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  // PATH under its usual name (and Windows' capitalisation) so the command is
  // findable; nothing else from the ambient environment is passed through.
  const path = sourceEnv.PATH ?? sourceEnv.Path;
  if (typeof path === "string") env.PATH = path;
  for (const [key, value] of Object.entries(overrides)) env[key] = value;
  return env;
}

/**
 * Spawn a real local worker as an {@link AcpChildProcess} over stdio. stdin/stdout
 * are piped for the ACP frames; stderr is inherited so the worker's own logging
 * never contaminates the stdout framing channel. stdout is read through a
 * {@link createBoundedLineReader}, so an oversized unterminated line terminates
 * the child (fail-closed) instead of growing memory.
 *
 * Isolation: the child gets a **minimal allowlisted environment** (via
 * {@link buildAcpChildEnv} — no inherited Jarvis credentials) and an explicit
 * `cwd`. It does **not**, and from Node cannot, enforce kernel-level *network*
 * egress isolation for the child; keeping the worker off the network (and
 * governing its own model/API access) is a host/provisioning concern — e.g.
 * systemd sandboxing or network namespaces, analogous to PR F's environment
 * egress policy. Do not rely on this adapter alone to keep the worker
 * networkless. This is the live adapter (like PR F's live wiring): it is not
 * exercised by the offline tests, which drive {@link StdioAcpTransport} through
 * a fake child.
 */
export function spawnAcpChild(options: {
  command: string;
  args?: readonly string[];
  maxLineBytes?: number;
  /** Minimal env for the child; defaults to {@link buildAcpChildEnv} (PATH only). */
  env?: Readonly<Record<string, string>>;
  /** Working directory for the child; defaults to the current directory. */
  cwd?: string;
}): AcpChildProcess {
  const child = nodeSpawn(options.command, options.args ? [...options.args] : [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: options.env ? { ...options.env } : buildAcpChildEnv(),
    cwd: options.cwd,
    windowsHide: true,
  });
  let lineHandler: ((line: string) => void) | undefined;
  let closeHandler: ((reason?: AcpStdioTransportFailureCode) => void) | undefined;
  let closed = false;
  const fireClose = (reason?: AcpStdioTransportFailureCode): void => {
    if (closed) return;
    closed = true;
    closeHandler?.(reason);
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
      // Classify the forced close as an output-limit breach, not a generic
      // crash, so the transport records accurate failure evidence.
      fireClose("output_limit_exceeded");
    },
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => reader.push(chunk));
  // Wrap so Node's close/error arguments are not passed as a (false) reason.
  child.on("close", () => fireClose());
  child.on("error", () => fireClose());
  return {
    writeLine(line: string): void {
      child.stdin?.write(`${line}\n`);
    },
    onStdoutLine(handler: (line: string) => void): void {
      lineHandler = handler;
    },
    onClose(handler: (reason?: AcpStdioTransportFailureCode) => void): void {
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
