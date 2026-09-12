import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import {
  assertConsistentEndpoint,
  checkPortAvailability,
  classifyBindError,
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

  it("reports not-ready on an available status missing its pipeline field", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { data: { status: "available" } })) as typeof fetch;
    const outcome = await probeLiveWork(api(), fetchImpl);
    assert.equal(outcome.kind, "not-ready");
  });

  it("reports not-ready on an unavailable status missing its reason field", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { data: { status: "unavailable" } })) as typeof fetch;
    const outcome = await probeLiveWork(api(), fetchImpl);
    assert.equal(outcome.kind, "not-ready");
  });

  it("reports not-ready on a non-200 2xx status, since the route only ever returns exactly 200", async () => {
    const fetchImpl = (async () =>
      jsonResponse(201, { data: { status: "available", pipeline: null } })) as typeof fetch;
    const outcome = await probeLiveWork(api(), fetchImpl);
    assert.equal(outcome.kind, "not-ready");
    assert.match((outcome as { detail: string }).detail, /HTTP 201/);
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

describe("classifyBindError", () => {
  it("classifies EADDRINUSE as occupied", () => {
    const error = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    assert.deepEqual(classifyBindError(error), { kind: "occupied", code: "EADDRINUSE" });
  });

  it("classifies any other bind error as check-failed, not occupied", () => {
    for (const code of ["EACCES", "EADDRNOTAVAIL", "ENOTFOUND"]) {
      const error = Object.assign(new Error(code), { code });
      assert.deepEqual(classifyBindError(error), { kind: "check-failed", code });
    }
  });

  it("falls back to UNKNOWN when the error carries no code", () => {
    assert.deepEqual(classifyBindError(new Error("mystery")), {
      kind: "check-failed",
      code: "UNKNOWN",
    });
  });
});

describe("assertConsistentEndpoint", () => {
  it("accepts a matching host and port", () => {
    assert.doesNotThrow(() =>
      assertConsistentEndpoint(api("http://127.0.0.1:3000/"), listen(3000)),
    );
  });

  it("accepts an IPv6 loopback URL against the same unbracketed listen host", () => {
    assert.doesNotThrow(() =>
      assertConsistentEndpoint(api("http://[::1]:3000/"), listen(3000, "::1")),
    );
  });

  it("rejects a mismatched port", () => {
    assert.throws(
      () => assertConsistentEndpoint(api("http://127.0.0.1:4000/"), listen(3000)),
      /do not agree/,
    );
  });

  it("rejects a mismatched host", () => {
    assert.throws(
      () => assertConsistentEndpoint(api("http://localhost:3000/"), listen(3000, "127.0.0.1")),
      /do not agree/,
    );
  });

  it("rejects an https API URL, since the spawned runtime only ever speaks plain HTTP", () => {
    assert.throws(
      () => assertConsistentEndpoint(api("https://127.0.0.1:3000/"), listen(3000)),
      /only ever speaks plain HTTP/,
    );
  });

  it("accepts a loopback API URL against a wildcard IPv4 bind (0.0.0.0 serves every local address)", () => {
    assert.doesNotThrow(() =>
      assertConsistentEndpoint(api("http://127.0.0.1:3000/"), listen(3000, "0.0.0.0")),
    );
  });

  it("accepts a loopback API URL against a wildcard IPv6 bind (:: serves every local address)", () => {
    assert.doesNotThrow(() =>
      assertConsistentEndpoint(api("http://[::1]:3000/"), listen(3000, "::")),
    );
  });

  it("still enforces the port even against a wildcard bind", () => {
    assert.throws(
      () => assertConsistentEndpoint(api("http://127.0.0.1:4000/"), listen(3000, "0.0.0.0")),
      /do not agree/,
    );
  });
});

interface FakeChild extends ChildProcessLike {
  /** Test-only: simulates the process exiting on its own (e.g. a crash), firing any `once("exit")` listeners. */
  crash(exitCode: number): void;
}

function fakeChild(): FakeChild {
  const exitListeners: (() => void)[] = [];
  return {
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal) {
      this.exitCode = 0;
      this.signalCode = (signal ?? "SIGTERM") as NodeJS.Signals;
      this.killed = true;
      queueMicrotask(() => exitListeners.splice(0).forEach((listener) => listener()));
      return true;
    },
    once(event, listener) {
      if (event === "exit") exitListeners.push(listener);
    },
    crash(exitCode) {
      this.exitCode = exitCode;
      exitListeners.splice(0).forEach((listener) => listener());
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

  it("rejects a probe that resolves ready only after the overall deadline has already passed", async () => {
    const child = fakeChild();
    const slowButEventuallyReadyProbe = (async () => {
      // Slower than the configured overall timeout, even though this
      // individual probe call does eventually succeed.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { kind: "ready" } as const;
    }) as typeof probeLiveWork;

    await assert.rejects(
      waitForHttpReady(api(), child, 10, slowButEventuallyReadyProbe),
      /did not become ready.*timeout had already elapsed/s,
    );
  });

  it("rejects immediately if the child exits while a probe is still pending, without waiting for it to settle", async () => {
    const child = fakeChild();
    let probeSettled = false;
    const probeFn = (async () => {
      // Never resolves within the test — proves the race, not the probe, wins.
      await new Promise(() => undefined);
      probeSettled = true;
      return { kind: "ready" } as const;
    }) as typeof probeLiveWork;

    const resultPromise = waitForHttpReady(api(), child, 5000, probeFn);
    await new Promise((resolve) => setImmediate(resolve));
    child.crash(1);

    await assert.rejects(resultPromise, /exited before it became ready/);
    assert.equal(probeSettled, false);
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

  it("reuses a healthy runtime even when its endpoint doesn't match the local listen config, since nothing gets spawned", async () => {
    // Endpoint consistency only matters on the spawn path — a probe that's
    // already `ready` must be reused regardless of how JARVIS_API_BASE_URL
    // compares to JARVIS_HTTP_HOST/PORT.
    const deps = baseDeps({
      api: api("http://127.0.0.1:9999/"),
      listen: listen(3000),
      probe: (async () => ({ kind: "ready" })) as typeof probeLiveWork,
    });

    await assert.doesNotReject(runLiveWorkDev(deps));
    assert.equal(deps.monitorCalls.length, 1);
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

  it("a port check that fails for a reason other than EADDRINUSE is reported distinctly, not as an occupied port", async () => {
    let spawnCount = 0;
    const deps = baseDeps({
      checkPort: (async () => ({
        kind: "check-failed",
        code: "EACCES",
      })) as typeof checkPortAvailability,
      spawnHttp: () => {
        spawnCount += 1;
        return { child: fakeChild(), tail: () => "" };
      },
    });

    await assert.rejects(runLiveWorkDev(deps), /Could not determine whether.*EACCES/s);
    await assert.rejects(runLiveWorkDev(deps), (error: Error) => {
      assert.doesNotMatch(error.message, /already in use by another process/);
      return true;
    });
    assert.equal(spawnCount, 0);
  });

  it("rejects a mismatched endpoint before spawning, when there is no healthy runtime to reuse", async () => {
    let spawnCount = 0;
    const deps = baseDeps({
      api: api("http://127.0.0.1:9999/"),
      listen: listen(3000),
      spawnHttp: () => {
        spawnCount += 1;
        return { child: fakeChild(), tail: () => "" };
      },
    });

    await assert.rejects(runLiveWorkDev(deps), /do not agree/);
    assert.equal(spawnCount, 0, "must not spawn against a config it already knows is inconsistent");
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

  it("keeps the signal handler registered through the monitor call, removing it only once the monitor returns", async () => {
    const child = fakeChild();
    const deps = baseDeps({
      spawnHttp: () => ({ child, tail: () => "" }),
      runMonitor: async () => {
        // `--once` installs no signal handler of its own at all (only the
        // default loop mode does, for its terminal restore) — this
        // launcher's own handler must still be active throughout, so a
        // Ctrl+C during a one-shot request still cleans up the child.
        assert.equal(deps.signalHandlers.length, 1);
      },
    });

    await runLiveWorkDev(deps);
    assert.equal(deps.signalHandlers.length, 0);
  });

  it("aborts the monitor's own signal on Ctrl+C, so a one-shot request in-flight is cancelled immediately", async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolveMonitor!: () => void;
    const monitorPromise = new Promise<void>((resolve) => {
      resolveMonitor = resolve;
    });
    const deps = baseDeps({
      runMonitor: async (_argv, signal) => {
        receivedSignal = signal;
        await monitorPromise;
      },
    });

    const runPromise = runLiveWorkDev(deps);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deps.signalHandlers.length, 1);

    deps.signalHandlers[0](); // simulate Ctrl+C while the one-shot request is in flight
    assert.equal(receivedSignal?.aborted, true, "the monitor's signal must fire immediately");
    resolveMonitor();

    await runPromise;
  });

  it("a signal during the initial probe cancels startup before anything is spawned", async () => {
    let spawnCount = 0;
    let resolveProbe!: (outcome: LiveWorkProbeOutcome) => void;
    const probePromise = new Promise<LiveWorkProbeOutcome>((resolve) => {
      resolveProbe = resolve;
    });
    const deps = baseDeps({
      probe: (() => probePromise) as unknown as typeof probeLiveWork,
      spawnHttp: () => {
        spawnCount += 1;
        return { child: fakeChild(), tail: () => "" };
      },
    });

    const runPromise = runLiveWorkDev(deps);
    assert.equal(
      deps.signalHandlers.length,
      1,
      "the early handler must be registered synchronously",
    );
    deps.signalHandlers[0](); // simulate Ctrl+C arriving while the probe is still in flight
    resolveProbe({ kind: "not-ready", detail: "no runtime yet" });

    await assert.rejects(runPromise, /Cancelled before the Jarvis HTTP runtime was ready/);
    assert.equal(spawnCount, 0, "must not spawn after cancellation");
    assert.equal(deps.monitorCalls.length, 0);
  });

  it("a signal while waiting for the spawned HTTP runtime stops that child and cancels startup", async () => {
    const child = fakeChild();
    let resolveWait!: () => void;
    const waitPromise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    const deps = baseDeps({
      spawnHttp: () => ({ child, tail: () => "" }),
      waitForReady: () => waitPromise,
    });

    const runPromise = runLiveWorkDev(deps);
    // Flush past the (already-resolved) probe/port-check/spawn steps so
    // control is parked on the controlled `waitForReady` promise below.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deps.signalHandlers.length, 1);

    deps.signalHandlers[0](); // simulate Ctrl+C while waiting for readiness
    assert.equal(child.killed, true, "the handler must stop the child it started immediately");
    resolveWait();

    await assert.rejects(runPromise, /Cancelled before the Jarvis HTTP runtime was ready/);
    assert.equal(deps.monitorCalls.length, 0);
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
