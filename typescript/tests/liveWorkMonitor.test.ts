import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LiveWorkResult } from "../src/development/liveWork.js";
import { fetchLiveWork, parseMonitorArgs } from "../src/tools/runLiveWorkMonitor.js";

describe("parseMonitorArgs", () => {
  it("defaults to a 5s colour loop", () => {
    assert.deepEqual(parseMonitorArgs([]), {
      once: false,
      color: true,
      intervalMs: 5000,
      width: undefined,
    });
  });

  it("parses --once, --no-color, and --interval / --width in both forms", () => {
    assert.deepEqual(
      parseMonitorArgs(["--once", "--no-color", "--interval", "2", "--width", "100"]),
      {
        once: true,
        color: false,
        intervalMs: 2000,
        width: 100,
      },
    );
    assert.deepEqual(parseMonitorArgs(["--interval=1.5", "--width=72"]), {
      once: false,
      color: true,
      intervalMs: 1500,
      width: 72,
    });
  });

  it("rejects out-of-range and unknown options", () => {
    assert.throws(() => parseMonitorArgs(["--interval", "0"]), /between 1 and 3600/);
    assert.throws(() => parseMonitorArgs(["--width", "10"]), /between 40 and 200/);
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
});
