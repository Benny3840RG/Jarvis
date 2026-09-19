import { setTimeout as sleep } from "node:timers/promises";

import { createPassWorker } from "./worker.js";

/**
 * Thin entrypoint so Tier 2 tests (PASS-01/02/03) can spawn the worker as
 * its own OS process and SIGKILL it. Prints `WORKER_READY` on stdout only
 * once `worker.getState() === 'RUNNING'` — i.e. the worker has actually
 * started polling its task queue — rather than after a fixed sleep, so the
 * process harness never races a worker that isn't listening yet.
 */
async function main(): Promise<void> {
  const worker = await createPassWorker();
  const runPromise = worker.run();

  while (worker.getState() !== "RUNNING") {
    await sleep(10);
  }
  console.log("WORKER_READY");

  await runPromise;
}

main().catch((error: unknown) => {
  console.error("Temporal PASS worker process failed:", error);
  process.exit(1);
});
