/**
 * Nolan ACP worker — Anthropic-backed decider (roadmap PR H — governed
 * commissioning slice, Gate D / D0).
 *
 * The live counterpart to `staticDecider()` in `nolanAcpWorker.ts`: an
 * {@link AcpDecider} that asks a real Claude model for one bounded
 * allow/deny/abstain judgement on an ACP permission request, using the
 * official `@anthropic-ai/sdk` (per this project's Claude API conventions —
 * never a hand-rolled HTTP client) with structured outputs (`output_config`)
 * so the model's answer is schema-constrained at the server, not parsed from
 * free text.
 *
 * Fail-closed by construction, matching {@link handleAcpRequestLine}'s
 * contract exactly: any anomaly — a network error, a safety refusal, a
 * malformed or schema-non-conforming response, `parsed_output` absent, or an
 * unrecognised decision string — makes this function *throw*. It never
 * fabricates a decision. `runAcpWorker`/`handleAcpRequestLine` already turn a
 * thrown decider into "emit nothing", which the transport then sees as a
 * crash/timeout: fail-closed all the way up, unchanged from every earlier
 * slice.
 *
 * Isolation is deliberately NOT this module's job. This code assumes it may
 * already have full network reachability (a plain `fetch`) OR none at all
 * (RestrictAddressFamilies) OR only a local forward-proxy — that distinction
 * is a host/sandbox concern (see `docs/operations/acp-worker-sandbox.md`).
 * The hooks this module gives the sandbox are `proxyUri` (a local TCP proxy)
 * and `proxySocketPath` (a local unix-socket proxy, preferred — it lets the
 * worker run with `PrivateNetwork=yes` and no host loopback at all): when
 * either is set, every request is tunnelled through it via `undici`'s
 * `ProxyAgent` — CONNECT-tunnelled for the HTTPS target, so TLS is still
 * terminated end-to-end against the real API host; the proxy never sees
 * plaintext or terminates TLS itself.
 *
 * Credentials follow the PR F convention exactly: only from
 * `$CREDENTIALS_DIRECTORY/<name>`, a bare filename, never inline, never an
 * arbitrary path, never logged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { z } from "zod";

import type { AcpPermissionDecision } from "./acpContract.js";
import type { AcpDecider } from "./nolanAcpWorker.js";
import type { AcpPermissionRequest } from "./acpTransport.js";

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REASON_LENGTH = 300;

/** A credential name must be a bare file name inside `$CREDENTIALS_DIRECTORY`. */
function isSafeCredentialName(name: string): boolean {
  return (
    name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".."
  );
}

export type AnthropicWorkerConfig = Readonly<{
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Local TCP forward-proxy the sandbox routes egress through; undefined = no TCP proxy. */
  proxyUri?: string;
  /**
   * Unix-socket path of the local CONNECT proxy. Preferred over `proxyUri`: it
   * lets the worker run under `PrivateNetwork=yes` (its own empty network
   * namespace — no host loopback at all), so it cannot reach any sibling
   * localhost service, only this one socket (bind-mounted in). Set from
   * `JARVIS_ACP_ANTHROPIC_PROXY_SOCKET`. See `docs/operations/acp-worker-sandbox.md`.
   */
  proxySocketPath?: string;
}>;

/**
 * Resolve the Anthropic-backed decider's configuration from the environment,
 * fail-closed: returns `null` unless an API key credential is present and
 * readable. `JARVIS_ACP_ANTHROPIC_MODEL`/`_TIMEOUT_MS`/`_PROXY_URI` are
 * optional; the model defaults to `claude-opus-5` per this project's Claude
 * API conventions — change it only on an explicit owner decision, not for
 * unilateral cost reasons.
 *
 * The key comes only from `$CREDENTIALS_DIRECTORY/<name>` (systemd
 * `LoadCredential`/`LoadCredentialEncrypted`), matching
 * `resolveGithubAppReadConfigFromEnv`'s convention: no inline key, no
 * arbitrary path.
 */
export function resolveAnthropicWorkerConfigFromEnv(
  environment: Environment = process.env,
): AnthropicWorkerConfig | null {
  const credentialsDir = environment.CREDENTIALS_DIRECTORY?.trim();
  const credentialName = environment.JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL?.trim();
  if (!credentialsDir || !credentialName || !isSafeCredentialName(credentialName)) return null;

  let apiKey: string;
  try {
    apiKey = readFileSync(join(credentialsDir, credentialName), "utf8").trim();
  } catch {
    return null;
  }
  if (!apiKey) return null;

  const model = environment.JARVIS_ACP_ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;

  const rawTimeout = environment.JARVIS_ACP_ANTHROPIC_TIMEOUT_MS?.trim();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    timeoutMs = parsed;
  }

  const proxyUri = environment.JARVIS_ACP_ANTHROPIC_PROXY_URI?.trim();
  const proxySocketPath = environment.JARVIS_ACP_ANTHROPIC_PROXY_SOCKET?.trim();

  return {
    apiKey,
    model,
    timeoutMs,
    ...(proxyUri ? { proxyUri } : {}),
    ...(proxySocketPath ? { proxySocketPath } : {}),
  };
}

/**
 * Build the undici {@link Dispatcher} that routes the worker's Anthropic egress
 * through the local CONNECT proxy, or `undefined` for a direct (unproxied)
 * fetch. Exported so the wiring is unit-testable without a real model call.
 *
 * A unix-socket proxy (`proxySocketPath`) takes precedence over a TCP one
 * (`proxyUri`): it is dialed via `undici`'s documented `proxyTls.socketPath`
 * (a `buildConnector` option — verified against the installed undici), so the
 * CONNECT tunnel reaches the proxy over a filesystem socket rather than any
 * TCP address. That lets the worker run with `PrivateNetwork=yes` and no host
 * loopback, closing the "worker can reach any sibling localhost service" gap.
 * TLS to the real API still terminates end-to-end through the tunnel; the proxy
 * never sees plaintext or the key either way.
 */
export function buildAnthropicProxyDispatcher(
  config: AnthropicWorkerConfig,
): Dispatcher | undefined {
  if (config.proxySocketPath) {
    // `uri` host/port is nominal — the socketPath connector overrides the dial.
    return new ProxyAgent({
      uri: "http://localhost",
      proxyTls: { socketPath: config.proxySocketPath },
    });
  }
  if (config.proxyUri) {
    return new ProxyAgent({ uri: config.proxyUri });
  }
  return undefined;
}

/** The schema the model's answer must satisfy. `reason` is bounded and never echoed as fact. */
const DecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "abstain"]),
  reason: z.string().max(MAX_REASON_LENGTH),
});

/**
 * The minimal surface this module calls on an Anthropic client — narrowed so
 * tests can inject a plain object instead of a real `Anthropic` instance or a
 * mocked `fetch`. A real `Anthropic` instance's `.messages` satisfies this
 * structurally.
 */
export interface AnthropicMessagesLike {
  parse(
    params: Anthropic.MessageCreateParamsNonStreaming & {
      output_config: { format: unknown };
    },
    options?: { timeout?: number },
  ): Promise<{
    stop_reason: string | null;
    parsed_output?: z.infer<typeof DecisionSchema> | null;
  }>;
}

const SYSTEM_PROMPT = [
  "You are a bounded ACP reviewer for the Jarvis/Nolan governed-action system.",
  "You are given one proposed action and must answer with exactly one structured",
  "decision: allow, deny, or abstain. You are advisory only — your answer can",
  "never by itself authorise or block anything; an independent governed approval",
  "always decides. Judge only the action described; you have no other context,",
  "no tools, and no ability to take any action yourself. If you are unsure,",
  "answer abstain rather than guessing.",
].join(" ");

function buildUserContent(request: AcpPermissionRequest): string {
  const lines = [`Action: ${request.action}`, `Request ID: ${request.requestId}`];
  if (request.detail !== undefined) lines.push(`Detail: ${request.detail}`);
  return lines.join("\n");
}

/**
 * Build an {@link AcpDecider} backed by a real Anthropic model call. `deps.client`
 * defaults to a real `Anthropic` client (constructed once, wired through
 * `config.proxyUri` via `undici`'s `ProxyAgent` when set); tests inject a fake
 * satisfying {@link AnthropicMessagesLike} instead.
 *
 * Never fabricates a decision (see module docs): every failure path throws,
 * which `handleAcpRequestLine` already treats as "emit nothing" — fail-closed.
 */
export function createAnthropicDecider(
  config: AnthropicWorkerConfig,
  deps: { client?: AnthropicMessagesLike } = {},
): AcpDecider {
  const client = deps.client ?? defaultAnthropicClient(config);

  return async (request: AcpPermissionRequest): Promise<AcpPermissionDecision> => {
    const response = await client.parse(
      {
        model: config.model,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(request) }],
        output_config: { format: zodOutputFormat(DecisionSchema) },
      },
      { timeout: config.timeoutMs },
    );

    // Fail-closed on stop_reason: only a normal completion (`end_turn`) is a
    // decision. A safety refusal, or any other stop (`max_tokens` truncation,
    // `pause_turn`, `tool_use`, or a null stop_reason), is an anomaly — even if a
    // `parsed_output` happens to be present, an incomplete/non-final response
    // must not be treated as a judgement. Reject everything but `end_turn`.
    if (response.stop_reason === "refusal") {
      throw new Error("Anthropic decider: request was refused.");
    }
    if (response.stop_reason !== "end_turn") {
      throw new Error(
        `Anthropic decider: unexpected stop_reason ${response.stop_reason ?? "null"} (expected end_turn).`,
      );
    }
    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error("Anthropic decider: response did not parse against the decision schema.");
    }
    // Belt-and-suspenders: DecisionSchema already constrains this enum, but a
    // future SDK/schema mismatch must still fail closed rather than pass
    // through an unrecognised value.
    if (
      parsed.decision !== "allow" &&
      parsed.decision !== "deny" &&
      parsed.decision !== "abstain"
    ) {
      throw new Error("Anthropic decider: decision was not one of allow/deny/abstain.");
    }
    return parsed.decision;
  };
}

/**
 * Real client construction, isolated so `createAnthropicDecider` stays
 * trivially testable. When `proxyUri` is set, every request is tunnelled
 * through it via `undici.ProxyAgent` — HTTPS targets are CONNECT-tunnelled,
 * so TLS terminates end-to-end against the real API host and the proxy never
 * sees decrypted traffic or credentials.
 */
function defaultAnthropicClient(config: AnthropicWorkerConfig): AnthropicMessagesLike {
  let dispatcher: Dispatcher | undefined;
  const proxied = config.proxySocketPath !== undefined || config.proxyUri !== undefined;
  const fetchImpl: typeof globalThis.fetch = proxied
    ? (input, init) => {
        dispatcher ??= buildAnthropicProxyDispatcher(config);
        return undiciFetch(input as never, {
          ...(init as object),
          dispatcher,
        }) as unknown as Promise<Response>;
      }
    : globalThis.fetch;

  const anthropic = new Anthropic({ apiKey: config.apiKey, fetch: fetchImpl });
  return anthropic.messages;
}

/**
 * Build the Anthropic-backed decider from the environment in one step:
 * resolve config, then construct the decider. Returns `null` — dormant,
 * exactly like every other `*FromEnv` resolver in this codebase — unless a
 * usable credential is configured. The one entrypoint a real worker binary
 * needs; callers that want to inject a fake client for tests should compose
 * {@link resolveAnthropicWorkerConfigFromEnv} and {@link createAnthropicDecider}
 * directly instead.
 */
export function createAnthropicDeciderFromEnv(
  environment: Environment = process.env,
): AcpDecider | null {
  const config = resolveAnthropicWorkerConfigFromEnv(environment);
  if (!config) return null;
  return createAnthropicDecider(config);
}
