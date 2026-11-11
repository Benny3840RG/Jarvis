import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

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
  /** True if refused, false if failed, null when no configured URL was supplied. */
  configuredUrlRefused: boolean | null;
  /** Both processes served the quote GET from the isolated backend. */
  quoteRecovered: boolean;
  /** sha256 of the quote GET body, for cross-run comparison. */
  quoteBodySha256: string;
  clientMatched: boolean;
  taskMatched: boolean;
  buildMatched: boolean;
  liveDirectoryUnchanged: boolean;
};

export type RestartRunner = (request: RestartedProcessRequest) => Promise<RestartedProcessResult>;

export type LocalV1RestartProofDeps = {
  /** Defaults to the real `readRestartedProcess`. Injected in tests. */
  restartRunner?: RestartRunner;
  /** Defaults to the OS resolver. Injected in tests to avoid external DNS. */
  resolveHostAddresses?: (host: string) => Promise<readonly string[]>;
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
    lower === "::1" ||
    lower === "0:0:0:0:0:0:0:1" ||
    (isIP(lower) === 4 && lower.startsWith("127."))
  );
}

function normaliseHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (isIP(host) === 6) {
    // URL canonicalises expanded IPv6 and IPv4-mapped IPv6 to one spelling.
    host = new URL(`http://[${host}]`).hostname.slice(1, -1);
  }
  return host;
}

function isLoopbackAlias(hostname: string): boolean {
  const host = normaliseHost(hostname);
  return (
    host === "localhost" ||
    isLoopbackHost(host) ||
    (isIP(host) === 6 && /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host))
  );
}

function portOf(url: URL): string {
  return url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
}

async function resolveBoundedHostAddresses(
  host: string,
  label: string,
  resolveHostAddresses: (host: string) => Promise<readonly string[]>,
): Promise<readonly string[]> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      resolveHostAddresses(host),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("resolution timed out")), 1_000);
      }),
    ]);
    if (
      addresses.length === 0 ||
      addresses.length > 64 ||
      addresses.some((address) => isIP(address) === 0)
    ) {
      throw new Error("resolution returned no usable addresses");
    }
    return addresses;
  } catch (error: unknown) {
    throw new LocalV1RecoveryDriverError(`Local V1 recovery driver could not resolve ${label}.`, {
      cause: error,
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function configuredSharesIsolatedEndpoint(
  configured: URL,
  isolated: URL,
  resolveHostAddresses: (host: string) => Promise<readonly string[]>,
): Promise<boolean> {
  if (portOf(configured) !== portOf(isolated)) return false;
  const configuredHost = normaliseHost(configured.hostname);
  if (isLoopbackAlias(configuredHost)) return true;
  if (isIP(configuredHost) !== 0) return false;

  // A same-port DNS name may include loopback after a non-loopback answer.
  // Resolve every answer without making a request to either backend.
  const addresses = await resolveBoundedHostAddresses(
    configuredHost,
    "the configured CONVEX_URL",
    resolveHostAddresses,
  );
  return addresses.some(isLoopbackAlias);
}

/** host:port with the scheme's default port filled in. Never carries a token. */
function endpointOf(url: URL): string {
  return `${url.hostname.toLowerCase()}:${portOf(url)}`;
}

async function assertIsolatedTarget(
  config: LocalV1RestartProofConfig,
  resolveHostAddresses: (host: string) => Promise<readonly string[]>,
): Promise<URL> {
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
  const host = normaliseHost(parsed.hostname);
  if (!isLoopbackAlias(host)) {
    throw new LocalV1RecoveryDriverError(
      "Local V1 recovery driver refuses an isolated Convex URL that is not a loopback host.",
    );
  }
  if (host === "localhost") {
    const addresses = await resolveBoundedHostAddresses(
      host,
      "the isolated Convex URL",
      resolveHostAddresses,
    );
    if (!addresses.every(isLoopbackAlias)) {
      throw new LocalV1RecoveryDriverError(
        "Local V1 recovery driver refuses an isolated Convex URL that is not a loopback host.",
      );
    }
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
): Promise<boolean | null> {
  const configured = config.configuredConvexUrl?.trim();
  if (configured === undefined || configured.length === 0) {
    // With no configured deployment there is nothing to refuse. The restart
    // proof below still runs against the isolated backend.
    return null;
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
    if (
      error instanceof Error &&
      /^Local V1 process restart refuses (?:a Convex cloud URL|the configured CONVEX_URL)\.$/.test(
        error.message,
      )
    ) {
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

/** Resolve existing ancestors even when the final directory does not exist. */
export async function canonicalRecoveryPath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  try {
    return await fs.realpath(absolute);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    // realpath reports ENOENT for a dangling symlink as well as a missing
    // entry. Rebuilding the path from its parent would hide where the link
    // points, so an entry that exists here is refused instead.
    let entryExists = true;
    try {
      await fs.lstat(absolute);
    } catch (lstatError: unknown) {
      if (!(lstatError instanceof Error && "code" in lstatError && lstatError.code === "ENOENT")) {
        throw lstatError;
      }
      entryExists = false;
    }
    if (entryExists) {
      throw new LocalV1RecoveryDriverError(
        "Local V1 recovery driver refuses a dangling symbolic link in a recovery path.",
      );
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalRecoveryPath(parent), path.basename(absolute));
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

type PinnedDirectory = { handle: fs.FileHandle; path: string; canonical: string };

// Linux /proc paths keep the opened inode, including in a child process. The
// parent holds both descriptors until the proof and its digest checks finish.
async function pinDirectory(candidate: string, canonical: string): Promise<PinnedDirectory> {
  const intended = await fs.stat(canonical, { bigint: true });
  const handle = await fs.open(
    canonical,
    0o10000000 | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!intended.isDirectory() || intended.dev !== opened.dev || intended.ino !== opened.ino) {
      throw new LocalV1RecoveryDriverError(
        "Local V1 recovery driver directory path changed during the restart proof.",
      );
    }
    const pinned = { handle, path: `/proc/${process.pid}/fd/${handle.fd}`, canonical };
    await Promise.all([assertPinnedPath(candidate, pinned), assertPinnedPath(canonical, pinned)]);
    return pinned;
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
}

async function assertPinnedPath(candidate: string, pinned: PinnedDirectory): Promise<void> {
  try {
    const [current, opened] = await Promise.all([
      fs.stat(candidate, { bigint: true }),
      pinned.handle.stat({ bigint: true }),
    ]);
    if (current.isDirectory() && current.dev === opened.dev && current.ino === opened.ino) return;
  } catch {
    // A removed path is also a changed path.
  }
  throw new LocalV1RecoveryDriverError(
    "Local V1 recovery driver directory path changed during the restart proof.",
  );
}

async function pinSeparateDataDirectories(
  config: LocalV1RestartProofConfig,
): Promise<{ live: PinnedDirectory; json: PinnedDirectory }> {
  if (process.platform !== "linux") {
    throw new LocalV1RecoveryDriverError(
      "Local V1 recovery driver requires Linux directory-handle containment.",
    );
  }
  const [requestedLive, requestedJson] = await Promise.all([
    canonicalRecoveryPath(config.liveDirectory),
    canonicalRecoveryPath(config.jsonDirectory),
  ]);
  if (isWithin(requestedLive, requestedJson) || isWithin(requestedJson, requestedLive)) {
    throw new LocalV1RecoveryDriverError(
      "Local V1 recovery driver refuses a JSON directory that overlaps live data.",
    );
  }
  const live = await pinDirectory(config.liveDirectory, requestedLive);
  try {
    const json = await pinDirectory(config.jsonDirectory, requestedJson);
    try {
      const [livePath, jsonPath] = await Promise.all([
        fs.realpath(live.path),
        fs.realpath(json.path),
      ]);
      if (isWithin(livePath, jsonPath) || isWithin(jsonPath, livePath)) {
        throw new LocalV1RecoveryDriverError(
          "Local V1 recovery driver refuses a JSON directory that overlaps live data.",
        );
      }
      await Promise.all([
        assertPinnedPath(config.liveDirectory, live),
        assertPinnedPath(live.canonical, live),
        assertPinnedPath(config.jsonDirectory, json),
        assertPinnedPath(json.canonical, json),
      ]);
      return { live, json };
    } catch (error: unknown) {
      await json.handle.close();
      throw error;
    }
  } catch (error: unknown) {
    await live.handle.close();
    throw error;
  }
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
  const resolveHostAddresses =
    deps.resolveHostAddresses ??
    (async (host: string) => (await lookup(host, { all: true })).map(({ address }) => address));
  const isolated = await assertIsolatedTarget(config, resolveHostAddresses);
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
    let configuredUrl: URL | null = null;
    if (configured.length > 0) {
      try {
        configuredUrl = new URL(configured);
      } catch (error: unknown) {
        throw new LocalV1RecoveryDriverError(
          "Local V1 recovery driver could not parse the configured CONVEX_URL.",
          { cause: error },
        );
      }
    }
    if (
      configuredUrl !== null &&
      (await configuredSharesIsolatedEndpoint(configuredUrl, isolated, resolveHostAddresses))
    ) {
      throw new LocalV1RecoveryDriverError(
        "Local V1 recovery driver refuses the configured CONVEX_URL as the isolated target.",
      );
    }
  }

  const pinned = await pinSeparateDataDirectories(config);
  try {
    const before = await localV1LiveDirectoryDigest(pinned.live.path);
    try {
      const pinnedConfig = {
        ...config,
        liveDirectory: pinned.live.path,
        jsonDirectory: pinned.json.path,
      };
      const configuredUrlRefused = await proveConfiguredUrlRefused(pinnedConfig, runner);
      await Promise.all([
        assertPinnedPath(config.liveDirectory, pinned.live),
        assertPinnedPath(config.jsonDirectory, pinned.json),
      ]);
      const result = await runner({
        jsonDirectory: pinned.json.path,
        liveDirectory: pinned.live.path,
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
      // Do not rely on the runner's flag alone: the quote read after the
      // restart must be byte-identical to the one before it.
      if (result.first.quoteBody !== result.second.quoteBody) {
        throw new LocalV1RecoveryDriverError(
          "Local V1 recovery driver read a different quote after the restart.",
        );
      }
      const after = await localV1LiveDirectoryDigest(pinned.live.path);
      const liveDirectoryUnchanged = after === before;
      if (!liveDirectoryUnchanged) {
        throw new LocalV1RecoveryDriverError(
          "Local V1 recovery driver changed the live data directory.",
        );
      }
      await Promise.all([
        assertPinnedPath(config.liveDirectory, pinned.live),
        assertPinnedPath(config.jsonDirectory, pinned.json),
      ]);
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
      let after: string;
      try {
        after = await localV1LiveDirectoryDigest(pinned.live.path);
      } catch {
        // Keep the failure that brought us here; the digest error would hide it.
        throw new LocalV1RecoveryDriverError(
          "Local V1 recovery driver failed and could not re-check the live data directory.",
          { cause: error },
        );
      }
      if (after !== before) {
        throw new LocalV1RecoveryDriverError(
          "Local V1 recovery driver changed the live data directory.",
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    await Promise.all([pinned.live.handle.close(), pinned.json.handle.close()]);
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
    `| Configured CONVEX_URL refused as target | ${record.configuredUrlRefused === null ? "N/A (no configured URL supplied)" : tick(record.configuredUrlRefused)} |`,
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
    (record.configuredUrlRefused === true || record.configuredUrlRefused === null) &&
    record.quoteRecovered &&
    record.clientMatched &&
    record.taskMatched &&
    record.buildMatched &&
    record.liveDirectoryUnchanged
  );
}
