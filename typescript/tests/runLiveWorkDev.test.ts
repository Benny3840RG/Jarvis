import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import {
  assertConsistentEndpoint,
  checkPortAvailability,
  probeLiveWork,
  runLiveWorkDev,
  stopChild,
  waitForHttpReady,
  type ChildProcessLike,
  type LiveWorkDevDeps,
  type LiveWorkProbeOutcome,
} from "../src/tools/runLiveWorkDev.js";
import type { JarvisApiConfig } from "../src/mcp/config.js";
import type { HttpListenConfig } from "../src/http/config.js";

function api(baseUrl = "http://127.0.0.1:3000/"): JarvisApiConfig {
  return { baseUrl: new URL(baseUrl), serviceToken: "a".repeat(32) };
}

function listen(port = 3000, host = "127.0.0.1"): HttpListenConfig {
  return { host, port };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probeLiveWork", () => {
  it("reports ready on a well-formed available payload", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { data: { status: "available", pipeline: null } })) as typeof fetch;
    assert.deepEqual(await probeLiveWork(api(), fetchImpl), { kind: "ready" });
  });

  it("reports ready on a well-formed unavailable payload", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { data: { status: "unavailable", reason: "no Convex" } })) as typeof fetch;
    assert.deepEqual(await probeLiveWork(api(), fetchImpl), { kind: "ready" });
  });

  it("reports not-ready when the connection is refused", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
    }) as typeof fetch;
    const outcome = await probeLiveWork(api(), fetchImpl);
    assert.equal(outcome.kind, "not-ready");
    assert.match((outcome as { detail: string }).detail, /no response from/);
  });

  it("reports not-ready with a token-specific detail on 401/403", async () => {
    const fetchImpl = (async () => jsonResponse(401, { title: "Unauthorized" })) as typeof fetch;
    const outcome = await probeLiveWork(api(), fetchImpl);
    assert.equal(outcome.kind, "not-ready");
    assert.match((outcome as { detail: string }).detail, /JARVIS_SERVICE_TOKEN/);
  });

  it("reports not-ready on 404 (route absent — an incompatible occupant)", async () => {
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const outcome = await probeLiveWork(api(), fetchImpl);
    assert.equal(outcome.kind, "not-ready");
    assert.match((outcome as { detail: string }).detail, /HTTP 404/);
  });

  it("reports not-ready on a 200 that isn't the live-work envelope shape", async () => {
    const fetchImpl = (async () => jsonResponse(200, { hello: "world" })) as typeof fetch;
    const outcome = await probeLiveWork(api(), fetchImpl);
    assert.equal(outcome.kind, "not-ready");
    assert.match((outcome as { detail: string }).detail, /not.*expected Jarvis live-work payload/);
  });

  it("reports not-ready on a 200 with invalid JSON", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    const outcome = await probeLiveWork(api(), fetchImpl);
    assert.equal(outcome.kind, "not-ready");
    assert.match((outcome as { detail: string }).detail, /did not return valid JSON/);
  });
});

describe("checkPortAvailability", () => {
  it("reports free for an unbound port", async () => {
    // Grab an OS-assigned free port, release it, then check it immediately.
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    assert.deepEqual(await checkPortAvailability("127.0.0.1", port), { kind: "free" });
  });

  it("reports occupied with the OS error code for a bound port", async () => {
    const occupied = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => {
        const address = occupied.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    try {
      const result = await checkPortAvailability("127.0.0.1", port);
      assert.deepEqual(result, { kind: "occupied", code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});

describe("assertConsistentEndpoint", () => {
  it("accepts matching ports", () => {
    assert.doesNotThrow(() =>
      assertConsistentEndpoint(api("http://127.0.0.1:3000/"), listen(3000)),
    );
  });

  it("rejects a mismatched port", () => {
    assert.throws(
      () => assertConsistentEndpoint(api("http://127.0.0.1:4000/"), listen(3000)),
      /do not agree/,
    );
  });
});

function fakeChild(): ChildProcessLike {
  return {
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal) {
      this.exitCode = 0;
      this.signalCode = (signal ?? "SIGTERM") as NodeJS.Signals;
      this.killed = true;
      return true;
    },
  };
}

describe("stopChild", () => {
  it("kills a still-running child", () => {
    const child = fakeChild();
    stopChild(child);
    assert.equal(child.killed, true);
  });

  it("does nothing to a child that already exited", () => {
    const child = fakeChild();
    child.exitCode = 0;
    let killCalled = false;
    child.kill = () => {
      killCalled = true;
      return true;
    };
    stopChild(child);
    assert.equal(killCalled, false);
  });

  it("does nothing to an already-killed child", () => {
    const child = fakeChild();
    child.killed = true;
    let killCalled = false;
    child.kill = () => {
      killCalled = true;
      return true;
    };
    stopChild(child);
    assert.equal(killCalled, false);
  });
});

describe("waitForHttpReady", () => {
  function sequencedProbe(outcomes: readonly LiveWorkProbeOutcome[]): typeof probeLiveWork {
    let index = 0;
    return (async () => {
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return outcome;
    }) as typeof probeLiveWork;
  }

  it("resolves once the probe reports ready", async () => {
    const child = fakeChild();
    const probeFn = sequencedProbe([
      { kind: "not-ready", detail: "starting" },
      { kind: "not-ready", detail: "starting" },
      { kind: "ready" },
    ]);
    await waitForHttpReady(api(), child, 5000, probeFn);
  });

  it("throws immediately if the child exits before becoming ready", async () => {
    const child = fakeChild();
    child.exitCode = 1;
    const probeFn = sequencedProbe([{ kind: "not-ready", detail: "starting" }]);
    await assert.rejects(
      waitForHttpReady(api(), child, 5000, probeFn),
      /exited before it became ready/,
    );
  });

  it("throws a timeout with the last probe detail once the deadline passes", async () => {
    const child = fakeChild();
    const probeFn = sequencedProbe([{ kind: "not-ready", detail: "still starting up" }]);
    await assert.rejects(
      waitForHttpReady(api(), child, 10, probeFn),
      /did not become ready.*still starting up/s,
    );
  });
});

function baseDeps(overrides: Partial<LiveWorkDevDeps> = {}): LiveWorkDevDeps & {
  logs: string[];
  monitorCalls: (readonly string[])[];
  signalHandlers: (() => void)[];
} {
  const logs: string[] = [];
  const monitorCalls: (readonly string[])[] = [];
  const signalHandlers: (() => void)[] = [];
  const deps: LiveWorkDevDeps = {
    api: api(),
    listen: listen(),
    argv: ["--once"],
    log: (message) => logs.push(message),
    probe: (async () => ({ kind: "not-ready", detail: "no runtime yet" })) as typeof probeLiveWork,
    checkPort: (async () => ({ kind: "free" })) as typeof checkPortAvailability,
    spawnHttp: () => ({ child: fakeChild(), tail: () => "" }),
    waitForReady: async () => undefined,
    runMonitor: async (argv) => {
      monitorCalls.push(argv);
    },
    onSignal: (handler) => {
      signalHandlers.push(handler);
      return () => {
        const index = signalHandlers.indexOf(handler);
        if (index >= 0) signalHandlers.splice(index, 1);
      };
    },
    ...overrides,
  };
  return Object.assign(deps, { logs, monitorCalls, signalHandlers });
}

describe("runLiveWorkDev", () => {
  it("clean start: spawns, waits for readiness, forwards argv to the monitor, then cleans up the child it started", async () => {
    let spawnCount = 0;
    let waitCalled = false;
    const child = fakeChild();
    const deps = baseDeps({
      argv: ["--once", "--no-color"],
      spawnHttp: () => {
        spawnCount += 1;
        return { child, tail: () => "" };
      },
      waitForReady: async () => {
        waitCalled = true;
      },
    });

    await runLiveWorkDev(deps);

    assert.equal(spawnCount, 1);
    assert.equal(waitCalled, true);
    assert.deepEqual(deps.monitorCalls, [["--once", "--no-color"]]);
    assert.equal(child.killed, true, "the child this run started must be cleaned up");
  });

  it("healthy-runtime reuse: never spawns, and there is no child to clean up", async () => {
    let spawnCount = 0;
    const deps = baseDeps({
      probe: (async () => ({ kind: "ready" })) as typeof probeLiveWork,
      spawnHttp: () => {
        spawnCount += 1;
        return { child: fakeChild(), tail: () => "" };
      },
    });

    await runLiveWorkDev(deps);

    assert.equal(spawnCount, 0, "must not start a duplicate runtime");
    assert.equal(deps.monitorCalls.length, 1);
    assert.ok(deps.logs.some((line) => /Reusing/.test(line)));
  });

  it("incompatible/404 runtime with the port occupied: fails closed, never spawns, never runs the monitor", async () => {
    let spawnCount = 0;
    const deps = baseDeps({
      probe: (async () => ({
        kind: "not-ready",
        detail: "returned HTTP 404",
      })) as typeof probeLiveWork,
      checkPort: (async () => ({
        kind: "occupied",
        code: "EADDRINUSE",
      })) as typeof checkPortAvailability,
      spawnHttp: () => {
        spawnCount += 1;
        return { child: fakeChild(), tail: () => "" };
      },
    });

    await assert.rejects(runLiveWorkDev(deps), /already in use by another process/);
    assert.equal(spawnCount, 0, "must not start a server on an occupied port");
    assert.equal(deps.monitorCalls.length, 0);
  });

  it("child cleanup: a startup failure after spawning still stops the child it started", async () => {
    const child = fakeChild();
    const deps = baseDeps({
      spawnHttp: () => ({ child, tail: () => "diagnostic output" }),
      waitForReady: async () => {
        throw new Error("Jarvis HTTP runtime did not become ready within 20s.");
      },
    });

    await assert.rejects(runLiveWorkDev(deps), /did not become ready.*diagnostic output/s);
    assert.equal(child.killed, true);
    assert.equal(deps.monitorCalls.length, 0);
  });

  it("registers an early signal handler that stops a started child, and removes it once the monitor takes over", async () => {
    const child = fakeChild();
    const deps = baseDeps({
      spawnHttp: () => ({ child, tail: () => "" }),
      runMonitor: async () => {
        // While the monitor "runs", the early startup handler must already be gone.
        assert.equal(deps.signalHandlers.length, 0);
      },
    });

    await runLiveWorkDev(deps);
    assert.equal(deps.signalHandlers.length, 0);
  });

  it("argument forwarding: passes argv through to the monitor unchanged, including in the reuse path", async () => {
    const deps = baseDeps({
      argv: ["--interval", "2", "--width", "100"],
      probe: (async () => ({ kind: "ready" })) as typeof probeLiveWork,
    });
    await runLiveWorkDev(deps);
    assert.deepEqual(deps.monitorCalls, [["--interval", "2", "--width", "100"]]);
  });
});
