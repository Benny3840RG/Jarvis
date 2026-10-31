import { sha256Hex } from "../../actions/sha256.js";
import { localV1LiveDirectoryDigest } from "./localV1Proof.js";
import {
  readRestartedProcess,
  type RestartedProcessRequest,
  type RestartedProcessResult,
} from "./localV1ProcessRestart.js";

/**
 * Driver for the Local V1 recovery commission (Stage 8 / LV1-09).
 *
 * This module automates the slice of the stage that can be proven without a
 * hand-written harness and without re-implementing the restore internals: the
 * host **restart proof** on an isolated self-hosted `convex-local-backend`, plus
 * the isolation guardrails and the evidence record around it. It reuses
 * `readRestartedProcess` unchanged — the behaviour that two HTTP processes serve
 * the same client, task, build, and quote from an isolated backend, with the
 * configured deployment URL refused and the live data directory left untouched.
 *
 * It deliberately does NOT automate capture, the isolated restore, the
 * JSON/API reread, or the Convex-function rollback assertions. Those depend on
 * post-restore id remapping that only resolves against a live isolated backend
 * (the restart reads physical ids from the Convex provider while the reread reads
 * stable ids from JSON), so they cannot be exercised in-process and are not
 * claimed here. `LOCAL_V1_RECOVERY_MANUAL_STEPS` lists them as the operator's
 * remaining work, and the evidence file records them as unchecked.
 *
 * Nothing in this driver marks the capture complete or clears #307's production
 * gate: it is evidence, not acceptance.
 */

export class LocalV1RecoveryDriverError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalV1RecoveryDriverError";
  }
}

/** Representative records the restart proof must serve again after a restart. */
export type LocalV1ProofIds = {
  clientId: string;
  taskId: string;
  buildId: string;
  quoteId: string;
};

export type LocalV1RestartProofConfig = {
  /**
   * Isolated self-hosted `convex-local-backend`, e.g. `http://127.0.0.1:3210`.
   * Must be a loopback host and must not be the configured deployment or a
   * `.convex.cloud` / `.convex.site` host. `readRestartedProcess` enforces the
   * full denylist; this driver adds an up-front loopback check and the
   * configured-URL-refusal evidence step.
   */
  isolatedConvexUrl: string;
  /** The configured deployment URL this proof must never hand to a child. */
  configuredConvexUrl: string | undefined;
  /** Passed to the isolated child as `JARVIS_DELIVERY_RUNTIME_TOKEN`. */
  deliveryRuntimeToken: string;
  /** Restored JSON directory prepared by the (manual) isolated restore step. */
  jsonDirectory: string;
  /** Live data directory whose bytes must be unchanged by the proof. */
  liveDirectory: string;
  /** Representative ids to prove. Convex-provider ids for task/build/quote. */
  ids: LocalV1ProofIds;
  /** Exact `main` commit SHA under test, recorded in the evidence. */
  sourceSha: string;
  /** Defaults to the restart harness token. A host backend can supply its own. */
  serviceToken?: string;
};

export type LocalV1RestartProofRecord = {
  sourceSha: string;
  /** `host:port` of the isolated backend. Never includes a token. */
  isolatedEndpoint: string;
  /** The configured CONVEX_URL was offered as the target and refused. */
  configuredUrlRefused: boolean;
  /** Both processes served the quote GET from the isolated backend. */
  quoteRecovered: boolean;
  /** sha256 of the quote GET body, for cross-run comparison. */
  quoteBodySha256: string;
  clientMatched: boolean;
  taskMatched: boolean;
  buildMatched: boolean;
  liveDirectoryUnchanged: boolean;
};

export type RestartRunner = (
  request: RestartedProcessRequest,
) => Promise<RestartedProcessResult>;

export type LocalV1RestartProofDeps = {
  /** Defaults to the real `readRestartedProcess`. Injected in tests. */
  restartRunner?: RestartRunner;
};

/**
 * Steps this driver does not automate. The operator runs them against the
 * isolated backend before the restart proof and records their evidence
 * alongside this record. They are listed, not performed, so nothing is
 * overclaimed.
 */
export const LOCAL_V1_RECOVERY_MANUAL_STEPS: readonly string[] = [
  "Capture the authoritative split with captureLocalV1Archive (business JSON + classic Convex snapshot + S6 quote inventory + idempotency receipts + PDF bytes).",
  "Validate the archive: manifest completeness=partial, strict readers pass, cross-domain references resolve.",
  "Restore with restoreLocalV1Archive into a fresh JSON directory and the isolated backend via a caller-supplied empty client.",
  "Reread through JSON stores + ConvexQuoteRepository.getQuote + HTTP GETs; check physical-id remap, quote fingerprints, and PDF blob digest equality.",
  "Rollback / safety: tombstoned idempotency keys refuse replay; a restored toolActions row does not refresh expiry; a restored receipt does not re-send mail; assertRecoverable still throws on the partial archive.",
];

function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new LocalV1RecoveryDriverError(`Local V1 recovery driver requires ${label}.`);
  }
  return trimmed;
}

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "127.0.0.1" ||
    lower === "localhost" ||
    lower === "::1" ||
    lower === "0:0:0:0:0:0:0:1" ||
    lower.startsWith("127.")
  );
}

/** host:port with the scheme's default port filled in. Never carries a token. */
function endpointOf(url: URL): string {
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
  return `${host}:${port}`;
}

function assertIsolatedTarget(config: LocalV1RestartProofConfig): URL {
  const raw = assertNonEmpty(config.isolatedConvexUrl, "the isolated Convex URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new LocalV1RecoveryDriverError(
      "Local V1 recovery driver isolated Convex URL is not an http(s) URL.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LocalV1RecoveryDriverError(
      "Local V1 recovery driver isolated Convex URL is not an http(s) URL.",
    );
  }
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!isLoopbackHost(host)) {
    throw new LocalV1RecoveryDriverError(
      "Local V1 recovery driver refuses an isolated Convex URL that is not a loopback host.",
    );
  }
  return parsed;
}

/**
 * Proves, before any child is spawned, that the restart harness refuses the
 * configured deployment URL as a target. Returns true when the refusal fires.
 * `assertIsolatedConvexUrl` runs synchronously inside the runner ahead of any
 * spawn, so this costs nothing and touches no backend.
 */
async function proveConfiguredUrlRefused(
  config: LocalV1RestartProofConfig,
  runner: RestartRunner,
): Promise<boolean> {
  const configured = config.configuredConvexUrl?.trim();
  if (configured === undefined || configured.length === 0) {
    // With no configured deployment there is nothing to refuse. The restart
    // proof below still runs against the isolated backend.
    return false;
  }
  try {
    await runner({
      jsonDirectory: config.jsonDirectory,
      liveDirectory: config.liveDirectory,
      clientId: config.ids.clientId,
      taskId: config.ids.taskId,
      buildId: config.ids.buildId,
      quoteId: config.ids.quoteId,
      configuredConvexUrl: config.configuredConvexUrl,
      isolatedConvexUrl: configured,
      deliveryRuntimeToken: config.deliveryRuntimeToken,
      serviceToken: config.serviceToken,
    });
  } catch (error: unknown) {
    if (error instanceof Error && /refuses the configured CONVEX_URL/.test(error.message)) {
      return true;
    }
    throw new LocalV1RecoveryDriverError(
      "Local V1 recovery driver could not confirm the configured CONVEX_URL is refused.",
      { cause: error },
    );
  }
  throw new LocalV1RecoveryDriverError(
    "Local V1 recovery driver expected the configured CONVEX_URL to be refused as a target.",
  );
}

/**
 * Runs the host restart proof on the isolated backend and returns an evidence
 * record. Fails closed: any error still verifies the live directory was not
 * changed before rethrowing.
 */
export async function runLocalV1RestartProof(
  config: LocalV1RestartProofConfig,
  deps: LocalV1RestartProofDeps = {},
): Promise<LocalV1RestartProofRecord> {
  const runner = deps.restartRunner ?? readRestartedProcess;
  const isolated = assertIsolatedTarget(config);
  assertNonEmpty(config.deliveryRuntimeToken, "JARVIS_DELIVERY_RUNTIME_TOKEN");
  assertNonEmpty(config.sourceSha, "the source commit SHA");
  for (const [value, label] of [
    [config.ids.clientId, "a client id"],
    [config.ids.taskId, "a task id"],
    [config.ids.buildId, "a build id"],
    [config.ids.quoteId, "a quote id"],
  ] as const) {
    assertNonEmpty(value, label);
  }
  if (config.configuredConvexUrl !== undefined) {
    const configured = config.configuredConvexUrl.trim();
    if (configured.length > 0 && endpointOf(isolated) === endpointOf(new URL(configured))) {
      throw new LocalV1RecoveryDriverError(
        "Local V1 recovery driver refuses the configured CONVEX_URL as the isolated target.",
      );
    }
  }

  const before = await localV1LiveDirectoryDigest(config.liveDirectory);
  try {
    const configuredUrlRefused = await proveConfiguredUrlRefused(config, runner);
    const result = await runner({
      jsonDirectory: config.jsonDirectory,
      liveDirectory: config.liveDirectory,
      clientId: config.ids.clientId,
      taskId: config.ids.taskId,
      buildId: config.ids.buildId,
      quoteId: config.ids.quoteId,
      configuredConvexUrl: config.configuredConvexUrl,
      isolatedConvexUrl: config.isolatedConvexUrl,
      deliveryRuntimeToken: config.deliveryRuntimeToken,
      serviceToken: config.serviceToken,
    });
    if (!result.quoteRecovered) {
      throw new LocalV1RecoveryDriverError(
        "Local V1 recovery driver did not recover the quote GET from the isolated backend.",
      );
    }
    const after = await localV1LiveDirectoryDigest(config.liveDirectory);
    const liveDirectoryUnchanged = after === before;
    if (!liveDirectoryUnchanged) {
      throw new LocalV1RecoveryDriverError(
        "Local V1 recovery driver changed the live data directory.",
      );
    }
    return {
      sourceSha: config.sourceSha.trim(),
      isolatedEndpoint: endpointOf(isolated),
      configuredUrlRefused,
      quoteRecovered: result.quoteRecovered,
      quoteBodySha256: sha256Hex(result.first.quoteBody),
      clientMatched: result.first.clientBody === result.second.clientBody,
      taskMatched: result.first.taskBody === result.second.taskBody,
      buildMatched: result.first.buildBody === result.second.buildBody,
      liveDirectoryUnchanged,
    };
  } catch (error: unknown) {
    const after = await localV1LiveDirectoryDigest(config.liveDirectory);
    if (after !== before) {
      throw new LocalV1RecoveryDriverError(
        "Local V1 recovery driver changed the live data directory.",
        { cause: error },
      );
    }
    throw error;
  }
}

function tick(value: boolean): string {
  return value ? "pass" : "FAIL";
}

/** Markdown evidence block for the restart proof, ready to attach to #307. */
export function renderLocalV1RestartProofEvidence(record: LocalV1RestartProofRecord): string {
  const lines = [
    "# Local V1 recovery — host restart proof",
    "",
    "Evidence, not acceptance. Automates the restart-proof slice of Stage 8 (LV1-09).",
    "",
    `- Source SHA under test: \`${record.sourceSha}\``,
    `- Isolated backend: \`${record.isolatedEndpoint}\` (loopback)`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Configured CONVEX_URL refused as target | ${tick(record.configuredUrlRefused)} |`,
    `| Quote GET recovered from isolated backend | ${tick(record.quoteRecovered)} |`,
    `| Client GET identical across restart | ${tick(record.clientMatched)} |`,
    `| Task GET identical across restart | ${tick(record.taskMatched)} |`,
    `| Build GET identical across restart | ${tick(record.buildMatched)} |`,
    `| Live data directory unchanged | ${tick(record.liveDirectoryUnchanged)} |`,
    "",
    `Quote body sha256: \`${record.quoteBodySha256}\``,
    "",
    "## Operator steps not automated by this driver",
    "",
    ...LOCAL_V1_RECOVERY_MANUAL_STEPS.map((step) => `- [ ] ${step}`),
  ];
  return lines.join("\n");
}

/** True only when every recorded check passed. */
export function localV1RestartProofPassed(record: LocalV1RestartProofRecord): boolean {
  return (
    record.quoteRecovered &&
    record.clientMatched &&
    record.taskMatched &&
    record.buildMatched &&
    record.liveDirectoryUnchanged
  );
}
