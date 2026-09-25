/**
 * Immutable Temporal worker build identity for the PASS preview (roadmap PR B).
 *
 * Temporal Worker Deployment Versioning pins each running workflow to the exact
 * worker build that started it. That guarantee is only as good as the build
 * identity the worker registers: a mutable tag such as `latest` would let a
 * redeploy silently move existing workflows onto new code, which is exactly the
 * drift the authority contract's AUTH-INV-04 forbids a Temporal worker from
 * doing on its own. So this module fails closed — it refuses any identity that
 * is not a concrete, immutable git commit — rather than defaulting to something
 * that looks convenient but cannot be reproduced.
 *
 * Pure and dependency-light on purpose: it imports only the `VersioningBehavior`
 * enum and the `WorkerDeploymentVersion` type from `@temporalio/common`, never
 * `@temporalio/worker`, so `tests/temporalWorkerBuildIdentity.test.ts` can
 * exercise it in the `npm run check` suite without loading native worker code.
 */
import { VersioningBehavior, type WorkerDeploymentVersion } from "@temporalio/common";
import type { WorkerDeploymentOptions } from "@temporalio/worker";

/** A full 40-character git commit SHA, lower-cased. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Deployment name and release-id charset. `.` is excluded because the canonical
 * worker version string is `deploymentName.buildId`; a `.` would corrupt parsing. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Values that name something mutable rather than one immutable build. Rejected
 * for the SHA, the deployment name and the release id alike. Compared
 * case-insensitively.
 */
const MUTABLE_TAGS = new Set(["latest", "head", "main", "master", "dev", "development", "current"]);

export const WORKER_BUILD_SHA_ENV = "JARVIS_BUILD_SHA";
export const WORKER_BUILD_SHA_FALLBACK_ENV = "GITHUB_SHA";
export const WORKER_RELEASE_ID_ENV = "JARVIS_BUILD_RELEASE";
export const WORKER_DEPLOYMENT_NAME_ENV = "JARVIS_TEMPORAL_DEPLOYMENT";
export const WORKER_VERSIONING_ENABLED_ENV = "JARVIS_TEMPORAL_VERSIONING";

export const DEFAULT_DEPLOYMENT_NAME = "jarvis-temporal-pass";

/** Temporal's default bound on a worker build id (`limit.workerBuildIdSize`). */
export const MAX_BUILD_ID_LENGTH = 255;

export class WorkerBuildIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerBuildIdentityError";
  }
}

/** Environment slice this module reads. Passed in so tests need no real `process.env`. */
export type BuildIdentityEnv = Readonly<Record<string, string | undefined>>;

function normalizeSha(env: BuildIdentityEnv): string {
  const raw = (env[WORKER_BUILD_SHA_ENV] ?? env[WORKER_BUILD_SHA_FALLBACK_ENV] ?? "").trim();
  if (raw === "") {
    throw new WorkerBuildIdentityError(
      `No build SHA: set ${WORKER_BUILD_SHA_ENV} (or ${WORKER_BUILD_SHA_FALLBACK_ENV}) to the full git commit.`,
    );
  }
  const sha = raw.toLowerCase();
  if (MUTABLE_TAGS.has(sha)) {
    throw new WorkerBuildIdentityError(
      `Build SHA "${raw}" names a mutable ref, not an immutable commit.`,
    );
  }
  if (!FULL_SHA.test(sha)) {
    throw new WorkerBuildIdentityError(
      `Build SHA "${raw}" is not a full 40-character git commit; an abbreviated or non-hex SHA is not immutable enough to pin a worker version.`,
    );
  }
  return sha;
}

function normalizeSegment(raw: string, field: string): string {
  // Validate the raw value, never a trimmed copy: surrounding whitespace is a
  // rejection, not something to silently normalize away (fail closed, per the
  // module doc). SAFE_SEGMENT already forbids whitespace, so a value with
  // leading/trailing spaces fails it; the empty check keeps that error legible
  // for a blank or whitespace-only value.
  if (raw.trim() === "") throw new WorkerBuildIdentityError(`${field} must not be empty.`);
  if (MUTABLE_TAGS.has(raw.trim().toLowerCase())) {
    throw new WorkerBuildIdentityError(
      `${field} "${raw}" names a mutable ref, not an immutable build.`,
    );
  }
  if (!SAFE_SEGMENT.test(raw)) {
    throw new WorkerBuildIdentityError(
      `${field} "${raw}" must match ${SAFE_SEGMENT} (letters, digits, "-" or "_"; no "." or whitespace).`,
    );
  }
  return raw;
}

/**
 * Resolve the immutable worker build identity from the environment, or throw
 * `WorkerBuildIdentityError` if it is missing or mutable. `buildId` is the git
 * SHA, prefixed with the release id when `JARVIS_BUILD_RELEASE` is set
 * (`release-<sha>`), so a given commit released twice still yields distinct,
 * traceable build ids. An unset release id means the bare SHA; a defined but
 * blank or whitespace-only one is rejected, not silently dropped.
 */
export function resolveWorkerBuildIdentity(env: BuildIdentityEnv): WorkerDeploymentVersion {
  const sha = normalizeSha(env);
  const deploymentName = normalizeSegment(
    env[WORKER_DEPLOYMENT_NAME_ENV] ?? DEFAULT_DEPLOYMENT_NAME,
    WORKER_DEPLOYMENT_NAME_ENV,
  );

  // Only an unset release id means "no release" (buildId is the bare SHA). A
  // *defined* value is always validated, so a blank or whitespace-only
  // JARVIS_BUILD_RELEASE is rejected rather than silently dropped — dropping it
  // could collapse two distinct releases of the same commit onto one build id.
  const releaseRaw = env[WORKER_RELEASE_ID_ENV];
  const buildId =
    releaseRaw === undefined
      ? sha
      : `${normalizeSegment(releaseRaw, WORKER_RELEASE_ID_ENV)}-${sha}`;

  // Temporal bounds a worker build id (`limit.workerBuildIdSize`, default 255).
  // A long release id could push `release-<40-hex sha>` past that and fail only
  // at worker registration, so reject it here instead. Validate the assembled
  // buildId rather than the release length alone, so the bound holds however
  // the build id is composed. (ASCII-only, so char length == byte length.)
  if (buildId.length > MAX_BUILD_ID_LENGTH) {
    throw new WorkerBuildIdentityError(
      `Build id is ${buildId.length} characters; Temporal bounds a worker build id to ${MAX_BUILD_ID_LENGTH}. Shorten ${WORKER_RELEASE_ID_ENV}.`,
    );
  }

  return { deploymentName, buildId };
}

/** Whether versioning was explicitly requested. Accepts `1`/`true`/`yes`/`on`. */
export function isVersioningRequested(env: BuildIdentityEnv): boolean {
  const raw = env[WORKER_VERSIONING_ENABLED_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Build the worker's deployment options.
 *
 * Returns `undefined` when versioning is not requested — the existing PASS
 * torture tests and any unversioned single-worker preview keep working exactly
 * as before. When versioning *is* requested, the build identity is mandatory
 * and this throws if it is missing or mutable (fail closed rather than silently
 * falling back to an unversioned worker). Behaviour is `PINNED`: a worker only
 * runs workflows started on its exact version, so a redeploy cannot migrate
 * live workflows onto new code without an explicit ramp.
 */
export function resolveWorkerDeploymentOptions(
  env: BuildIdentityEnv,
): WorkerDeploymentOptions | undefined {
  if (!isVersioningRequested(env)) return undefined;
  return {
    version: resolveWorkerBuildIdentity(env),
    useWorkerVersioning: true,
    defaultVersioningBehavior: VersioningBehavior.PINNED,
  };
}
