import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LiveWorkResult } from "../src/development/liveWork.js";
import { fetchLiveWork, parseMonitorArgs } from "../src/tools/runLiveWorkMonitor.js";

describe("parseMonitorArgs", () => {
  it("defaults to a 5s colour loop with an 8s fetch timeout", () => {
    assert.deepEqual(parseMonitorArgs([]), {
      once: false,
      color: true,
      intervalMs: 5000,
      width: undefined,
      timeoutMs: 8000,
    });
  });

  it("parses --once, --no-color, and --interval / --width / --timeout in both forms", () => {
    assert.deepEqual(
      parseMonitorArgs([
        "--once",
        "--no-color",
        "--interval",
        "2",
        "--width",
        "100",
        "--timeout",
        "15",
      ]),
      {
        once: true,
        color: false,
        intervalMs: 2000,
        width: 100,
        timeoutMs: 15000,
      },
    );
    assert.deepEqual(parseMonitorArgs(["--interval=1.5", "--width=72", "--timeout=3"]), {
      once: false,
      color: true,
      intervalMs: 1500,
      width: 72,
      timeoutMs: 3000,
    });
  });

  it("rejects out-of-range and unknown options", () => {
    assert.throws(() => parseMonitorArgs(["--interval", "0"]), /between 1 and 3600/);
    assert.throws(() => parseMonitorArgs(["--width", "10"]), /between 40 and 200/);
    assert.throws(() => parseMonitorArgs(["--timeout", "0"]), /between 1 and 120/);
    assert.throws(() => parseMonitorArgs(["--timeout", "121"]), /between 1 and 120/);
    assert.throws(() => parseMonitorArgs(["--interval"]), /needs a value/);
    assert.throws(() => parseMonitorArgs(["--frequency", "2"]), /Unknown option/);
  });
});

describe("fetchLiveWork", () => {
  it("passes a successful result straight through", async () => {
    const result: LiveWorkResult = { status: "available", pipeline: null };
    assert.deepEqual(await fetchLiveWork({ getDevelopmentLiveWork: async () => result }), result);
  });

  it("maps a transport failure to a truthful UNAVAILABLE rather than throwing", async () => {
    const result = await fetchLiveWork({
      getDevelopmentLiveWork: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
      },
    });
    assert.equal(result.status, "unavailable");
    assert.match(
      result.status === "unavailable" ? result.reason : "",
      /Could not reach Jarvis: connect ECONNREFUSED/,
    );
  });

  it("never hangs: a request that never resolves still settles as UNAVAILABLE", async () => {
    const result = await fetchLiveWork(
      // Simulates a client that ignores the abort signal entirely — the
      // backstop below must still guarantee this settles, independent of
      // whether the client honours cancellation.
      { getDevelopmentLiveWork: () => new Promise(() => {}) },
      20,
    );
    assert.equal(result.status, "unavailable");
    assert.match(result.status === "unavailable" ? result.reason : "", /did not respond within/);
  });

  it("hands the client an abort signal that fires on timeout, so a real request can cancel itself", async () => {
    let receivedSignal: AbortSignal | undefined;
    const result = await fetchLiveWork(
      {
        getDevelopmentLiveWork: (signal) =>
          new Promise((_resolve, reject) => {
            receivedSignal = signal;
            signal?.addEventListener("abort", () => reject(new Error("upstream request aborted")));
          }),
      },
      20,
    );
    assert.equal(result.status, "unavailable");
    assert.equal(
      receivedSignal?.aborted,
      true,
      "the client must have received a signal, and it must have fired",
    );
  });

  it("settles immediately on an externally-aborted signal, without waiting for the request timeout", async () => {
    const externalController = new AbortController();
    const resultPromise = fetchLiveWork(
      { getDevelopmentLiveWork: () => new Promise(() => {}) }, // never resolves on its own
      10_000, // a timeout far longer than this test should ever take
      externalController.signal,
    );
    externalController.abort();

    const result = await resultPromise;
    assert.equal(result.status, "unavailable");
    assert.match(
      result.status === "unavailable" ? result.reason : "",
      /Cancelled before Jarvis responded/,
    );
  });

  it("propagates external cancellation into the client's own signal too, not just the race", async () => {
    const externalController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const resultPromise = fetchLiveWork(
      {
        getDevelopmentLiveWork: (signal) => {
          receivedSignal = signal;
          return new Promise(() => {});
        },
      },
      10_000,
      externalController.signal,
    );
    externalController.abort();
    await resultPromise;

    assert.equal(receivedSignal?.aborted, true);
  });
});
