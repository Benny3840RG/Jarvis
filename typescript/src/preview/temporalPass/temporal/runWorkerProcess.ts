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

  // Race the readiness poll against `runPromise` itself: if the worker
  // fails to start (e.g. can't reach the server) `run()` rejects before
  // ever reaching RUNNING, and the poll loop below would otherwise spin
  // forever waiting for a state transition that will never come — while
  // `runPromise`'s rejection sits unobserved until Node's default
  // unhandled-rejection policy kills the process with no useful message.
  // Racing it in means that rejection reaches `main()`'s own catch handler
  // immediately, with the real error attached.
  const readinessAbort = new AbortController();
  try {
    await Promise.race([
      (async () => {
        try {
          while (worker.getState() !== "RUNNING") {
            await sleep(10, undefined, { signal: readinessAbort.signal });
          }
        } catch (error: unknown) {
          if (!readinessAbort.signal.aborted) throw error;
        }
      })(),
      runPromise.then(() => {
        throw new Error("Worker run() returned before reaching the RUNNING state");
      }),
    ]);
  } finally {
    // If run() wins the race (failure or early return), stop the readiness
    // timer immediately. Otherwise the outstanding timer can keep this thin
    // worker process alive after shutdown and make Tier 2 tests hang.
    readinessAbort.abort();
  }
  console.log("WORKER_READY");

  await runPromise;
}

main().catch((error: unknown) => {
  console.error("Temporal PASS worker process failed:", error);
  process.exit(1);
});
