import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import proto from "@temporalio/proto";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import {
  type BuildIdentityEnv,
  describeWorkerVersion,
  resolveWorkerDeploymentOptions,
} from "../../src/preview/temporalPass/temporal/buildIdentity.js";
import { rampParkWorkflow, releaseSignal } from "./fixtures/rampParkWorkflow.js";
import { createLocalTemporalEnv } from "./helpers/testEnv.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const RAMP_WF_PATH = path.resolve(dirname, "fixtures/rampParkWorkflow.ts");

const NAMESPACE = "default";
// The numeric enum the DescribeWorkflowExecution response reports for a pinned
// execution (`VERSIONING_BEHAVIOR_PINNED = 1`), read from the proto module
// rather than hard-coded so it tracks the SDK.
const PINNED_BEHAVIOR = proto.temporal.api.enums.v1.VersioningBehavior.VERSIONING_BEHAVIOR_PINNED;
// Two distinct, immutable full-SHA build identities standing in for two code
// versions. buildIdentity.ts rejects anything that isn't a concrete 40-hex
// commit, so these must be real hex — not "v1"/"v2" tags.
const SHA_V1 = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const SHA_V2 = "0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a";

/**
 * The env slice a versioned Jarvis worker reads. Versioning is *requested*
 * (`JARVIS_TEMPORAL_VERSIONING=1`) and the build identity is a concrete commit,
 * so `resolveWorkerDeploymentOptions` returns real PINNED options rather than
 * `undefined`.
 */
function buildEnv(sha: string, deploymentName: string): BuildIdentityEnv {
  return {
    JARVIS_TEMPORAL_VERSIONING: "1",
    JARVIS_BUILD_SHA: sha,
    JARVIS_TEMPORAL_DEPLOYMENT: deploymentName,
  };
}

// PASS-15: Temporal Worker Deployment Versioning must PIN each execution to the
// exact worker build that started it. A redeploy that makes a new version
// Current must NOT migrate an in-flight execution onto new code, and a rollback
// must route new executions back to the old version. This is the runtime proof
// behind the authority contract's AUTH-INV-04 (a Temporal worker cannot move
// live workflows onto new code on its own) — the build-identity resolution it
// relies on is unit-tested in tests/temporalWorkerBuildIdentity.test.ts; here
// the shipped `resolveWorkerDeploymentOptions` output drives real workers
// against a real server so the pinning is observed, not assumed.
describe("PASS-15 worker deployment versioning ramp", () => {
  let env: TestWorkflowEnvironment;
  const workers: Worker[] = [];
  const runs: Promise<void>[] = [];

  before(async () => {
    env = await createLocalTemporalEnv();
  });

  after(async () => {
    for (const worker of workers) worker.shutdown();
    await Promise.allSettled(runs);
    if (env) await env.teardown();
  });

  async function startVersionedWorker(
    buildIdentityEnv: BuildIdentityEnv,
    taskQueue: string,
  ): Promise<{ canonical: string; buildId: string }> {
    const options = resolveWorkerDeploymentOptions(buildIdentityEnv);
    assert.ok(options, "versioning requested → resolveWorkerDeploymentOptions must return options");
    const evidence = describeWorkerVersion(options);
    assert.equal(evidence.versioned, true);
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: RAMP_WF_PATH,
      workerDeploymentOptions: options,
    });
    workers.push(worker);
    runs.push(worker.run());
    // Narrowed by the assertion above, but TS keeps the union — read the
    // versioned branch's fields explicitly.
    return evidence.versioned
      ? { canonical: evidence.canonical, buildId: evidence.buildId }
      : assert.fail("unreachable: evidence.versioned asserted true");
  }

  /** Poll until the deployment reports the given canonical version as registered. */
  async function waitForRegisteredVersion(
    deploymentName: string,
    canonical: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const described = await env.client.workflowService.describeWorkerDeployment({
          namespace: NAMESPACE,
          deploymentName,
        });
        const summaries = described.workerDeploymentInfo?.versionSummaries ?? [];
        if (summaries.some((summary) => summary.version === canonical)) return;
      } catch {
        // NOT_FOUND until the first worker has polled and registered — keep waiting.
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for version "${canonical}" to register`);
  }

  async function setCurrentVersion(deploymentName: string, buildId: string): Promise<void> {
    await env.client.workflowService.setWorkerDeploymentCurrentVersion({
      namespace: NAMESPACE,
      deploymentName,
      buildId,
      // The worker has already registered (we waited for it), but keep these on
      // so a poller-visibility lag on the server side can't spuriously reject
      // the ramp in this short-lived test.
      allowNoPollers: true,
      ignoreMissingTaskQueues: true,
    });
  }

  /** Poll a running workflow until the server has assigned it a pinned version. */
  async function waitForPinnedVersion(
    workflowId: string,
    timeoutMs = 15_000,
  ): Promise<{ version: string; buildId: string; behavior: number | null | undefined }> {
    const handle = env.client.workflow.getHandle(workflowId);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const info = (await handle.describe()).raw.workflowExecutionInfo?.versioningInfo;
      if (info?.version) {
        return {
          version: info.version,
          buildId: info.deploymentVersion?.buildId ?? "",
          behavior: info.behavior,
        };
      }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for a pinned version on workflow "${workflowId}"`);
  }

  it("pins in-flight executions to their start version across a v1→v2→rollback ramp", async () => {
    const deploymentName = `jarvis-pass-ramp-${randomUUID()}`;
    const taskQueue = `temporal-pass-ramp-${randomUUID()}`;

    // --- v1 becomes Current, W1 starts and pins to v1 -----------------------
    const v1 = await startVersionedWorker(buildEnv(SHA_V1, deploymentName), taskQueue);
    await waitForRegisteredVersion(deploymentName, v1.canonical);
    await setCurrentVersion(deploymentName, v1.buildId);

    const w1Id = `ramp-w1-${randomUUID()}`;
    const h1 = await env.client.workflow.start(rampParkWorkflow, {
      taskQueue,
      workflowId: w1Id,
    });
    const w1Pinned = await waitForPinnedVersion(w1Id);
    assert.equal(w1Pinned.version, v1.canonical, "W1 pins to v1");
    assert.equal(w1Pinned.buildId, v1.buildId);
    assert.equal(w1Pinned.behavior, PINNED_BEHAVIOR, "W1 versioning behavior is PINNED");

    // --- v2 ramps to Current; W2 gets v2, W1 stays pinned to v1 -------------
    const v2 = await startVersionedWorker(buildEnv(SHA_V2, deploymentName), taskQueue);
    await waitForRegisteredVersion(deploymentName, v2.canonical);
    await setCurrentVersion(deploymentName, v2.buildId);

    const w2Id = `ramp-w2-${randomUUID()}`;
    const h2 = await env.client.workflow.start(rampParkWorkflow, {
      taskQueue,
      workflowId: w2Id,
    });
    const w2Pinned = await waitForPinnedVersion(w2Id);
    assert.equal(w2Pinned.version, v2.canonical, "W2 (started after ramp) pins to v2");
    assert.equal(w2Pinned.buildId, v2.buildId);

    // The ramp must NOT have migrated the already-running W1 onto v2.
    const w1AfterRamp = (await h1.describe()).raw.workflowExecutionInfo?.versioningInfo;
    assert.equal(w1AfterRamp?.version, v1.canonical, "in-flight W1 stays on v1 after the ramp");

    // --- rollback: v1 Current again; W3 routes back to v1 -------------------
    await setCurrentVersion(deploymentName, v1.buildId);
    const w3Id = `ramp-w3-${randomUUID()}`;
    const h3 = await env.client.workflow.start(rampParkWorkflow, {
      taskQueue,
      workflowId: w3Id,
    });
    const w3Pinned = await waitForPinnedVersion(w3Id);
    assert.equal(w3Pinned.version, v1.canonical, "W3 (started after rollback) pins back to v1");

    // Release all three; W1 in particular must complete on the still-running
    // v1 worker it was pinned to, proving the in-flight execution survived the
    // ramp end-to-end rather than merely reporting an unchanged label.
    await h1.signal(releaseSignal);
    await h2.signal(releaseSignal);
    await h3.signal(releaseSignal);
    assert.equal(await h1.result(), "released", "W1 completes on its pinned v1 worker");
    assert.equal(await h2.result(), "released");
    assert.equal(await h3.result(), "released");
  });
});
