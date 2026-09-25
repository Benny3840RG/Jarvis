import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toCanonicalString, VersioningBehavior } from "@temporalio/common";

import {
  DEFAULT_DEPLOYMENT_NAME,
  isVersioningRequested,
  resolveWorkerBuildIdentity,
  resolveWorkerDeploymentOptions,
  WorkerBuildIdentityError,
} from "../src/preview/temporalPass/temporal/buildIdentity.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("Temporal worker build identity", () => {
  it("resolves a full git SHA into a pinned deployment version", () => {
    const version = resolveWorkerBuildIdentity({ JARVIS_BUILD_SHA: SHA });
    assert.deepEqual(version, { deploymentName: DEFAULT_DEPLOYMENT_NAME, buildId: SHA });
    // Round-trips through Temporal's own canonical encoder without corruption.
    assert.equal(toCanonicalString(version), `${DEFAULT_DEPLOYMENT_NAME}.${SHA}`);
  });

  it("lower-cases the SHA and honours the GITHUB_SHA fallback", () => {
    const version = resolveWorkerBuildIdentity({ GITHUB_SHA: SHA.toUpperCase() });
    assert.equal(version.buildId, SHA);
  });

  it("prefixes the build id with the release id so one commit released twice differs", () => {
    const first = resolveWorkerBuildIdentity({ JARVIS_BUILD_SHA: SHA, JARVIS_BUILD_RELEASE: "r1" });
    const second = resolveWorkerBuildIdentity({
      JARVIS_BUILD_SHA: SHA,
      JARVIS_BUILD_RELEASE: "r2",
    });
    assert.equal(first.buildId, `r1-${SHA}`);
    assert.equal(second.buildId, `r2-${SHA}`);
    assert.notEqual(first.buildId, second.buildId);
  });

  it("honours a custom deployment name", () => {
    const version = resolveWorkerBuildIdentity({
      JARVIS_BUILD_SHA: SHA,
      JARVIS_TEMPORAL_DEPLOYMENT: "jarvis-prod",
    });
    assert.equal(version.deploymentName, "jarvis-prod");
  });

  it("fails closed when no SHA is set", () => {
    assert.throws(() => resolveWorkerBuildIdentity({}), WorkerBuildIdentityError);
    assert.throws(
      () => resolveWorkerBuildIdentity({ JARVIS_BUILD_SHA: "  " }),
      WorkerBuildIdentityError,
    );
  });

  it("rejects mutable refs as the SHA", () => {
    for (const ref of ["latest", "HEAD", "main", "master", "dev", "current"]) {
      assert.throws(
        () => resolveWorkerBuildIdentity({ JARVIS_BUILD_SHA: ref }),
        WorkerBuildIdentityError,
        ref,
      );
    }
  });

  it("rejects an abbreviated or non-hex SHA as not immutable enough", () => {
    for (const bad of [SHA.slice(0, 12), `${SHA.slice(0, 39)}z`, `${SHA} `.repeat(1) + "extra"]) {
      assert.throws(
        () => resolveWorkerBuildIdentity({ JARVIS_BUILD_SHA: bad }),
        WorkerBuildIdentityError,
        bad,
      );
    }
  });

  it("rejects a deployment name or release id with a dot, whitespace or mutable tag", () => {
    for (const name of ["has.dot", "has space", " leading", "trailing ", "latest", ""]) {
      assert.throws(
        () =>
          resolveWorkerBuildIdentity({ JARVIS_BUILD_SHA: SHA, JARVIS_TEMPORAL_DEPLOYMENT: name }),
        WorkerBuildIdentityError,
        `deployment:${name}`,
      );
    }
    for (const release of ["has.dot", "has space", " leading", "trailing ", "dev"]) {
      assert.throws(
        () => resolveWorkerBuildIdentity({ JARVIS_BUILD_SHA: SHA, JARVIS_BUILD_RELEASE: release }),
        WorkerBuildIdentityError,
        `release:${release}`,
      );
    }
  });

  it("treats versioning as off unless explicitly requested", () => {
    assert.equal(isVersioningRequested({}), false);
    assert.equal(isVersioningRequested({ JARVIS_TEMPORAL_VERSIONING: "0" }), false);
    assert.equal(resolveWorkerDeploymentOptions({ JARVIS_BUILD_SHA: SHA }), undefined);
    for (const on of ["1", "true", "yes", "on", "ON"]) {
      assert.equal(isVersioningRequested({ JARVIS_TEMPORAL_VERSIONING: on }), true, on);
    }
  });

  it("builds pinned deployment options when versioning is requested", () => {
    const options = resolveWorkerDeploymentOptions({
      JARVIS_TEMPORAL_VERSIONING: "1",
      JARVIS_BUILD_SHA: OTHER_SHA,
    });
    assert.deepEqual(options, {
      version: { deploymentName: DEFAULT_DEPLOYMENT_NAME, buildId: OTHER_SHA },
      useWorkerVersioning: true,
      defaultVersioningBehavior: VersioningBehavior.PINNED,
    });
  });

  it("fails closed when versioning is requested without a valid build identity", () => {
    assert.throws(
      () => resolveWorkerDeploymentOptions({ JARVIS_TEMPORAL_VERSIONING: "1" }),
      WorkerBuildIdentityError,
    );
    assert.throws(
      () =>
        resolveWorkerDeploymentOptions({
          JARVIS_TEMPORAL_VERSIONING: "1",
          JARVIS_BUILD_SHA: "latest",
        }),
      WorkerBuildIdentityError,
    );
  });
});
