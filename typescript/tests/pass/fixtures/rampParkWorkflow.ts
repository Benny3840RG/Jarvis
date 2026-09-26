/**
 * TEST FIXTURE ONLY — used exclusively by worker-versioning-ramp.test.ts
 * (PASS-15).
 *
 * A deliberately minimal workflow that parks on a signal so the test can hold
 * an execution genuinely in flight while it ramps the deployment's Current
 * Version from v1 to v2. Worker Deployment Versioning (PINNED) is a
 * server/worker-level property keyed off the *worker's* registered build
 * identity and the execution's pinned version — it does not depend on what the
 * workflow body does — so the full PASS mission machinery (activities,
 * approval-signal correlation, the merge boundary) would add moving parts and
 * flake surface without making the versioning proof any stronger. The real
 * mission workflow's own behaviour is already covered by PASS-01..14.
 *
 * What PASS-15 does exercise for real is the shipped
 * `resolveWorkerDeploymentOptions` code path from
 * `src/preview/temporalPass/temporal/buildIdentity.ts`: the test builds each
 * worker's `workerDeploymentOptions` through that function, not by hand.
 *
 * Never import this outside that test.
 */
import { condition, defineSignal, setHandler } from "@temporalio/workflow";

/** Releases the parked workflow so it can complete. */
export const releaseSignal = defineSignal("release");

export async function rampParkWorkflow(): Promise<string> {
  let released = false;
  setHandler(releaseSignal, () => {
    released = true;
  });
  await condition(() => released);
  return "released";
}
