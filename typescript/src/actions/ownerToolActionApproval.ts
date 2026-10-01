/**
 * Owner-operated client for the existing ToolAction approval route.
 *
 * This is a client, not an authority issuer: it reads a stored proposal over
 * the existing loopback HTTP API, shows it to a human, and only if the human
 * confirms and types the owner approval token at a hidden prompt does it call
 * `POST .../approve`. It never reads the approval token from the environment,
 * arguments, files or logs, never approves anything the owner has not seen, and
 * never executes. Every ambiguous or changed condition fails closed before the
 * approval request is sent.
 */

import { createHash } from "node:crypto";

import { isLoopbackHost } from "../http/config.js";
import type { ToolAction } from "./toolActions.js";

export type OwnerApprovalErrorCode =
  | "payload-mismatch"
  | "payload-changed"
  | "unsupported-action"
  | "not-approvable"
  | "cancelled"
  | "not-interactive"
  | "approval-failed"
  | "approval-unconfirmed";

export class OwnerApprovalError extends Error {
  constructor(
    readonly code: OwnerApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OwnerApprovalError";
  }
}

/**
 * The complete envelope the owner expects to approve. Every field is mandatory
 * and bound into the payload digest; anything else is refused.
 */
export type OwnerApprovalExpectation = {
  tool: string;
  operation: string;
  arguments: Record<string, unknown>;
  requiredAuthority: string;
  destructive: boolean;
};

/** The only operation this client can approve; its review text is specific to it. */
export const OWNER_APPROVAL_SUPPORTED_TOOL = "home";
export const OWNER_APPROVAL_SUPPORTED_OPERATION = "announce";

function isSupportedOperation(payload: { tool: string; operation: string }): boolean {
  return (
    payload.tool === OWNER_APPROVAL_SUPPORTED_TOOL &&
    payload.operation === OWNER_APPROVAL_SUPPORTED_OPERATION
  );
}

export type OwnerApprovalTransport = {
  getAction(projectId: string, actionId: string): Promise<ToolAction>;
  approve(
    projectId: string,
    actionId: string,
    body: { expectedRevision: number; approvalToken: string },
  ): Promise<ToolAction>;
};

export type OwnerApprovalIo = {
  write(text: string): void;
  /** Visible prompt. `null` means the owner cancelled or input ended. */
  confirm(prompt: string): Promise<string | null>;
  /** Hidden prompt. `null` means the owner cancelled or input ended. */
  readSecret(prompt: string): Promise<string | null>;
  /** Informational only: the host-pinned address for a target, when known to this client. */
  pinnedAddress?: (target: string) => string | undefined;
};

export type OwnerApprovalResult = {
  actionId: string;
  state: ToolAction["state"];
  approvedAt?: string;
  approvalExpiresAt?: string;
  consumptionPolicy?: ToolAction["consumptionPolicy"];
  baseRevision: number;
  payloadDigest: string;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalPayloadDigest(payload: {
  tool: string;
  operation: string;
  arguments: Record<string, unknown>;
  requiredAuthority: string;
  destructive: boolean;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        tool: payload.tool,
        operation: payload.operation,
        arguments: payload.arguments,
        requiredAuthority: payload.requiredAuthority,
        destructive: payload.destructive,
      }),
    )
    .digest("hex");
}

function matchesExpectation(action: ToolAction, expectation: OwnerApprovalExpectation): boolean {
  return canonicalPayloadDigest(action) === canonicalPayloadDigest(expectation);
}

function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length > 0) output = output.split(secret).join("<redacted>");
  }
  return output;
}

function renderReview(
  action: ToolAction,
  digest: string,
  pinnedAddress: ((target: string) => string | undefined) | undefined,
): string {
  const lines = [
    "",
    "Owner approval review",
    "---------------------",
    `Action:    ${action.actionId}`,
    `Project:   ${action.projectId} (revision ${action.baseRevision})`,
    `State:     ${action.state}`,
    `Operation: ${action.tool}:${action.operation} (authority ${action.requiredAuthority}, destructive: ${action.destructive})`,
  ];
  const args = action.arguments;
  const target = typeof args.target === "string" ? args.target : "";
  const address = pinnedAddress?.(target);
  lines.push(
    `Speaker:   ${target}`,
    address
      ? `Pinned address: ${address}`
      : "Pinned address: not available to this client (verify the host target map)",
    `Volume:    ${String(args.volume)}`,
    "Text:",
    String(args.message),
  );
  lines.push(
    `Envelope digest (sha256): ${digest}`,
    "",
    "Approving authorises this announcement, which plays now on that speaker once executed.",
    "It may interrupt any media already playing and does not automatically resume it.",
    "",
  );
  return lines.join("\n");
}

export async function runOwnerApproval(input: {
  projectId: string;
  actionId: string;
  expectation: OwnerApprovalExpectation;
  transport: OwnerApprovalTransport;
  io: OwnerApprovalIo;
}): Promise<OwnerApprovalResult> {
  const { projectId, actionId, expectation, transport, io } = input;
  if (!isSupportedOperation(expectation)) {
    throw new OwnerApprovalError(
      "unsupported-action",
      `This client approves only ${OWNER_APPROVAL_SUPPORTED_TOOL}:${OWNER_APPROVAL_SUPPORTED_OPERATION} actions. Nothing was sent.`,
    );
  }
  const digest = canonicalPayloadDigest(expectation);

  const reviewed = await transport.getAction(projectId, actionId);
  if (reviewed.state !== "proposed" || reviewed.isApprovalExpired === true) {
    throw new OwnerApprovalError(
      "not-approvable",
      `Action is ${reviewed.state}${reviewed.isApprovalExpired ? " (approval expired)" : ""}; only a proposed action can be approved. Nothing was sent.`,
    );
  }
  if (!matchesExpectation(reviewed, expectation)) {
    throw new OwnerApprovalError(
      "payload-mismatch",
      "The stored action does not match the payload you expect. Nothing was approved.",
    );
  }

  io.write(renderReview(reviewed, digest, io.pinnedAddress));

  const phrase = `APPROVE ${actionId}`;
  const confirmation = await io.confirm(`Type "${phrase}" to continue, anything else cancels: `);
  if (confirmation === null || confirmation.trim() !== phrase) {
    throw new OwnerApprovalError("cancelled", "Cancelled. Nothing was approved.");
  }

  const token = await io.readSecret("Owner approval token (hidden): ");
  if (token === null || token.trim().length === 0) {
    throw new OwnerApprovalError("cancelled", "Cancelled. Nothing was approved.");
  }

  const current = await transport.getAction(projectId, actionId);
  if (
    current.state !== "proposed" ||
    current.isApprovalExpired === true ||
    current.baseRevision !== reviewed.baseRevision ||
    !matchesExpectation(current, expectation)
  ) {
    throw new OwnerApprovalError(
      "payload-changed",
      "The stored action changed after you reviewed it. Nothing was approved.",
    );
  }

  const secrets = [token];
  try {
    await transport.approve(projectId, actionId, {
      expectedRevision: current.baseRevision,
      approvalToken: token,
    });
  } catch (error: unknown) {
    const detail = redact(error instanceof Error ? error.message : String(error), secrets);
    throw new OwnerApprovalError(
      "approval-failed",
      `Approval request failed and was not retried: ${detail}. Re-inspect the action before trying again.`,
    );
  }

  const approved = await transport.getAction(projectId, actionId);
  if (
    approved.state !== "approved" ||
    approved.isApprovalExpired === true ||
    !matchesExpectation(approved, expectation)
  ) {
    throw new OwnerApprovalError(
      "approval-unconfirmed",
      `Approval was sent but the readback shows state "${approved.state}" or a changed payload. Do not assume it is approved; re-inspect the action.`,
    );
  }

  io.write(
    `Approved. Expires: ${approved.approvalExpiresAt ?? "not reported"}. Nothing has been executed.\n`,
  );
  return {
    actionId: approved.actionId,
    state: approved.state,
    approvedAt: approved.approvedAt,
    approvalExpiresAt: approved.approvalExpiresAt,
    consumptionPolicy: approved.consumptionPolicy,
    baseRevision: approved.baseRevision,
    payloadDigest: digest,
  };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function createHttpOwnerApprovalTransport(options: {
  baseUrl: URL;
  serviceToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): OwnerApprovalTransport {
  if (!isLoopbackHost(options.baseUrl.hostname)) {
    throw new Error("The owner approval client only talks to a loopback Jarvis API.");
  }
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraSecrets: readonly string[] = [],
  ): Promise<ToolAction> {
    const secrets = [options.serviceToken, ...extraSecrets];
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, options.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${options.serviceToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Jarvis API request failed: ${redact(reason, secrets)}`, { cause: error });
    }
    if (!response.ok) {
      let problemType = "unknown";
      try {
        const problem = (await response.json()) as { type?: unknown };
        if (typeof problem.type === "string") problemType = problem.type.slice(0, 120);
      } catch {
        // Non-JSON error body: the status alone is reported.
      }
      throw new Error(
        `Jarvis API responded HTTP ${response.status} (${redact(problemType, secrets)})`,
      );
    }
    const parsed = (await response.json()) as ToolAction;
    if (!parsed || typeof parsed !== "object" || typeof parsed.actionId !== "string") {
      throw new Error("Jarvis API returned an unexpected response.");
    }
    return parsed;
  }

  const actionPath = (projectId: string, actionId: string) =>
    `api/v1/projects/${encodeURIComponent(projectId)}/tool-actions/${encodeURIComponent(actionId)}`;

  return {
    getAction: (projectId, actionId) => request("GET", actionPath(projectId, actionId)),
    approve: (projectId, actionId, body) =>
      request("POST", `${actionPath(projectId, actionId)}/approve`, body, [body.approvalToken]),
  };
}

type HiddenInput = {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
};

/**
 * Reads one line without echoing it. Resolves `null` on Ctrl-C, Ctrl-D or end
 * of input; rejects when stdin is not an interactive terminal so a piped or
 * scripted caller can never supply the token.
 */
export function readHiddenLine(
  prompt: string,
  input: HiddenInput,
  output: { write(text: string): unknown },
): Promise<string | null> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(
      new OwnerApprovalError(
        "not-interactive",
        "Owner approval requires an interactive terminal; input was not a TTY.",
      ),
    );
  }
  const setRawMode = input.setRawMode.bind(input);
  return new Promise((resolve) => {
    let value = "";
    output.write(prompt);
    setRawMode(true);
    input.resume();

    const finish = (result: string | null) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      setRawMode(false);
      input.pause();
      output.write("\n");
      resolve(result);
    };
    const onEnd = () => finish(null);
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString("utf8");
      if (text.startsWith("\u001b")) return; // arrow keys and other escape sequences
      for (const char of text) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003" || char === "\u0004") return finish(null);
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
  });
}

const CREDENTIAL_OPTION = /token|secret|password|authorization|credential/i;

export type OwnerApprovalArgs = { projectId: string; actionId: string; expectFile: string };

/** Parses `argv` (already sliced past `node script`). Credentials are never accepted as options. */
export function parseOwnerApprovalArgs(argv: readonly string[]): OwnerApprovalArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}".`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (CREDENTIAL_OPTION.test(name)) {
      throw new Error(
        `${name} is not accepted: credentials are entered only at the hidden prompt.`,
      );
    }
    if (!["--project", "--action", "--expect-file"].includes(name)) {
      throw new Error(`Unknown option ${name}.`);
    }
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      index += 1;
      value = argv[index];
    }
    if (value === undefined || value.length === 0) throw new Error(`${name} needs a value.`);
    values.set(name, value);
  }
  const need = (name: string) => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`${name} is required.`);
    return value;
  };
  return {
    projectId: need("--project"),
    actionId: need("--action"),
    expectFile: need("--expect-file"),
  };
}

export function parseOwnerApprovalExpectation(text: string): OwnerApprovalExpectation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Expectation file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expectation file must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const text_ = (key: string) => {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`expectation.${key} must be a non-empty string.`);
    }
    return value;
  };
  const tool = text_("tool");
  const operation = text_("operation");
  if (!isSupportedOperation({ tool, operation })) {
    throw new Error(
      `This client approves only ${OWNER_APPROVAL_SUPPORTED_TOOL}:${OWNER_APPROVAL_SUPPORTED_OPERATION} actions.`,
    );
  }
  const args = record.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("expectation.arguments must be a JSON object.");
  }
  const requiredAuthority = text_("requiredAuthority");
  if (typeof record.destructive !== "boolean") {
    throw new Error("expectation.destructive must be a boolean.");
  }
  const expectation: OwnerApprovalExpectation = {
    tool,
    operation,
    arguments: args as Record<string, unknown>,
    requiredAuthority,
    destructive: record.destructive,
  };
  return expectation;
}
