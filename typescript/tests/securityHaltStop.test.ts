import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setImmediate as flush } from "node:timers/promises";

import { z } from "zod";

import { RunningExecutionRegistry } from "../src/actions/runningExecutions.js";
import type { ToolAction } from "../src/actions/toolActions.js";
import {
  EXECUTION_LEASE_RENEW_MS,
  InMemoryToolExecutionReceiptStore,
  ToolExecutionService,
  type ExecutionEligibilityStore,
  type SingleUseConsumptionClaimStore,
  type ToolExecutionDefinition,
} from "../src/actions/toolExecution.js";
import { FileHaltStore, HALT_FILE_BASENAME } from "../src/security/haltControl.js";
import {
  haltRefFor,
  FileHaltAckStore,
  HALT_ACK_FILE_BASENAME,
  HaltSupervisor,
} from "../src/security/haltSupervisor.js";
import { runSecurityHalt } from "../src/tools/runSecurityHalt.js";

const NOW = new Date("2026-11-21T01:00:00.000Z");

let directory = "";
let halts: FileHaltStore;
let acks: FileHaltAckStore;
let ackPath = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "nolan-halt-stop-"));
  halts = new FileHaltStore(path.join(directory, HALT_FILE_BASENAME));
  ackPath = path.join(directory, HALT_ACK_FILE_BASENAME);
  acks = new FileHaltAckStore(ackPath);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function action(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "action-stop-1",
    requestId: "request-stop-1",
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool: "notes",
    operation: "create",
    arguments: { text: "hello" },
    rationale: "Write a note.",
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: "proposal-stop-1",
    proposedBy: "user",
    approvedBy: "user",
    consumptionPolicy: "single-use",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

class Claims implements SingleUseConsumptionClaimStore {
  calls = 0;
  onClaim: () => void = () => undefined;
  async claim(_action: ToolAction, claimId: string) {
    this.calls += 1;
    this.onClaim();
    return { claimed: true, claimId };
  }
}

class Leases implements ExecutionEligibilityStore {
  verified = 0;
  released = 0;
  onVerify: () => void = () => undefined;
  async verify() {
    this.verified += 1;
    this.onVerify();
    return { eligible: true as const };
  }
  async release() {
    this.released += 1;
  }
}

function build(
  definition: Partial<ToolExecutionDefinition>,
  registry: RunningExecutionRegistry,
  claims = new Claims(),
  leases = new Leases(),
) {
  const executor = new ToolExecutionService(
    [
      {
        tool: "notes",
        operation: "create",
        schema: z.object({ text: z.string() }),
        async execute() {
          return { ok: true };
        },
        ...definition,
      },
    ],
    new InMemoryToolExecutionReceiptStore(),
    undefined,
    claims,
    leases,
    EXECUTION_LEASE_RENEW_MS,
    undefined,
    registry,
  );
  return { executor, claims, leases };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await flush();
  assert.ok(condition(), "condition never became true");
}

describe("halt cancels in-flight governed executions", () => {
  it("ends an effect it interrupts as indeterminate, never succeeded or failed", async () => {
    const registry = new RunningExecutionRegistry();
    let started = false;
    const { executor } = build(
      {
        execute: (_args, signal) =>
          new Promise((_, reject) => {
            started = true;
            signal.addEventListener("abort", () => reject(new Error("provider aborted")));
          }),
      },
      registry,
    );
    const pending = executor.execute({ action: action(), authority: "T1", idempotencyKey: "k1" });
    await waitFor(() => started);
    assert.equal(registry.unsettled(), 1);
    assert.equal(registry.cancelAll(), 1);
    const result = await pending;
    assert.equal(result.status, "indeterminate");
    await waitFor(() => registry.unsettled() === 0);
  });

  it("keeps an effect that ignores the abort counted until it settles", async () => {
    const registry = new RunningExecutionRegistry();
    const provider = deferred<{ ok: boolean }>();
    let started = false;
    const { executor } = build(
      {
        execute: () => {
          started = true;
          return provider.promise;
        },
      },
      registry,
    );
    const pending = executor.execute({ action: action(), authority: "T1", idempotencyKey: "k2" });
    await waitFor(() => started);
    registry.cancelAll();
    assert.equal((await pending).status, "indeterminate");
    await flush();
    assert.equal(registry.unsettled(), 1, "the provider may still be acting");
    assert.equal(registry.cancelAll(), 0, "an already cancelled execution is not counted twice");
    provider.resolve({ ok: true });
    await waitFor(() => registry.unsettled() === 0);
  });

  it("still links a later halt to a provider left running after a timeout", async () => {
    const registry = new RunningExecutionRegistry();
    const provider = deferred<{ ok: boolean }>();
    let providerSignal: AbortSignal | undefined;
    // A provider that only stops on the signal's abort event, not the timeout.
    const { executor } = build(
      {
        execute: (_args, signal) => {
          providerSignal = signal;
          return provider.promise;
        },
      },
      registry,
    );
    const result = await executor.execute({
      action: action(),
      authority: "T1",
      idempotencyKey: "k-timeout",
      timeoutMs: 5,
    });
    assert.equal(result.status, "indeterminate");
    await flush();
    assert.equal(registry.unsettled(), 1, "the timed-out provider may still be acting");
    assert.equal(providerSignal?.aborted, true, "the timeout already aborted the provider");
    assert.equal(registry.cancelAll(), 1, "the halt still reaches the unsettled execution");
    provider.resolve({ ok: true });
    await waitFor(() => registry.unsettled() === 0);
  });

  it("refuses without claiming when the halt lands during preflight", async () => {
    const registry = new RunningExecutionRegistry();
    let executed = 0;
    let inPreflight = false;
    const { executor, claims } = build(
      {
        preflight: (_args, signal) =>
          new Promise<void>((resolve) => {
            inPreflight = true;
            // An abort-ignoring preflight that passes anyway must still be refused.
            signal.addEventListener("abort", () => resolve());
          }),
        async execute() {
          executed += 1;
          return { ok: true };
        },
      },
      registry,
    );
    const pending = executor.execute({ action: action(), authority: "T1", idempotencyKey: "k3" });
    await waitFor(() => inPreflight);
    registry.cancelAll();
    const result = await pending;
    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "safety-blocked");
    assert.equal(claims.calls, 0);
    assert.equal(executed, 0);
    await waitFor(() => registry.unsettled() === 0);
  });

  it("refuses without running the effect when the halt lands during the claim", async () => {
    const registry = new RunningExecutionRegistry();
    let executed = 0;
    const claims = new Claims();
    claims.onClaim = () => registry.cancelAll();
    const { executor } = build(
      {
        async execute() {
          executed += 1;
          return { ok: true };
        },
      },
      registry,
      claims,
    );
    const result = await executor.execute({
      action: action(),
      authority: "T1",
      idempotencyKey: "k4",
    });
    assert.equal(result.errorCode, "safety-blocked");
    assert.equal(executed, 0);
  });

  it("releases a reusable lease when the halt lands during the lease check", async () => {
    const registry = new RunningExecutionRegistry();
    let executed = 0;
    const leases = new Leases();
    leases.onVerify = () => registry.cancelAll();
    const { executor } = build(
      {
        async execute() {
          executed += 1;
          return { ok: true };
        },
      },
      registry,
      new Claims(),
      leases,
    );
    const result = await executor.execute({
      action: action({ consumptionPolicy: "reusable" }),
      authority: "T1",
      idempotencyKey: "k5",
    });
    assert.equal(result.errorCode, "safety-blocked");
    assert.equal(executed, 0);
    assert.equal(leases.released, 1);
  });
});

describe("halt supervisor", () => {
  it("writes nothing while running", async () => {
    const supervisor = new HaltSupervisor(halts, acks, new RunningExecutionRegistry());
    await supervisor.tick();
    assert.deepEqual(await acks.read(), { kind: "none" });
  });

  it("acknowledges, waits for unsettled effects, then reports verified stopped", async () => {
    const registry = new RunningExecutionRegistry();
    const run = registry.begin();
    const provider = deferred();
    run.trackEffect(provider.promise);
    registry.end(run);

    let clock = NOW.getTime();
    const supervisor = new HaltSupervisor(halts, acks, registry, {
      now: () => new Date(clock),
      pid: 4242,
    });
    const record = await halts.halt("owner stop", NOW);

    clock += 1_000;
    await supervisor.tick();
    assert.equal(run.signal.aborted, true);
    const first = await acks.read();
    assert.equal(first.kind, "ack");
    assert.equal(first.kind === "ack" && first.ack.haltRef, `record:${record.id}`);
    assert.equal(first.kind === "ack" && first.ack.cancelledExecutions, 1);
    assert.equal(first.kind === "ack" && first.ack.unsettledExecutions, 1);
    assert.equal(first.kind === "ack" && first.ack.verifiedStoppedAt, null);
    assert.equal((await stat(ackPath)).mode & 0o777, 0o600);

    provider.resolve();
    await waitFor(() => registry.unsettled() === 0);
    clock += 1_000;
    await supervisor.tick();
    const second = await acks.read();
    assert.equal(second.kind === "ack" && second.ack.acknowledgedAt, "2026-11-21T01:00:01.000Z");
    assert.equal(second.kind === "ack" && second.ack.verifiedStoppedAt, "2026-11-21T01:00:02.000Z");
    assert.equal(second.kind === "ack" && second.ack.cancelledExecutions, 1);
  });

  it("owns initial runtime start, stops before verified stopped and restarts on resume", async () => {
    let running = false;
    let starts = 0;
    let stops = 0;
    const managed = {
      async start() {
        starts += 1;
        running = true;
      },
      async stop() {
        stops += 1;
        running = false;
      },
    };
    const supervisor = new HaltSupervisor(halts, acks, new RunningExecutionRegistry(), {
      managedRuntimes: [managed],
      pid: 4242,
      now: () => NOW,
    });

    await supervisor.tick();
    assert.equal(running, true);
    assert.equal(starts, 1);

    await halts.halt("owner stop", NOW);
    await supervisor.tick();
    assert.equal(running, false);
    assert.equal(stops, 1);
    const halted = await acks.read();
    assert.equal(halted.kind === "ack" && halted.ack.version, 2);
    assert.equal(halted.kind === "ack" && halted.ack.scope, "service-controlled-work");
    assert.equal(halted.kind === "ack" && halted.ack.stoppedRuntimes, 1);
    assert.equal(halted.kind === "ack" && halted.ack.verifiedStoppedAt, NOW.toISOString());

    await halts.resume("continue", new Date(NOW.getTime() + 1_000));
    await supervisor.tick();
    assert.equal(running, true);
    assert.equal(starts, 2);
  });

  it("cancels governed executions without waiting for a slow runtime stop", async () => {
    const registry = new RunningExecutionRegistry();
    const run = registry.begin();
    const stop = deferred();
    let tickSettled = false;
    const supervisor = new HaltSupervisor(halts, acks, registry, {
      managedRuntimes: [
        {
          async start() {},
          async stop() {
            await stop.promise;
          },
        },
      ],
    });

    await halts.halt("owner stop", NOW);
    const cancelled = new Promise<void>((resolve) => {
      run.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const tick = supervisor.tick().finally(() => {
      tickSettled = true;
    });
    await cancelled;
    assert.equal(tickSettled, false);
    assert.deepEqual(await acks.read(), { kind: "none" });

    stop.resolve();
    await tick;
    assert.equal((await acks.read()).kind, "ack");
  });

  it("retries a managed runtime restart after a failed resume tick", async () => {
    let running = false;
    let starts = 0;
    const supervisor = new HaltSupervisor(halts, acks, new RunningExecutionRegistry(), {
      managedRuntimes: [
        {
          async start() {
            starts += 1;
            if (starts === 2) throw new Error("start failed");
            running = true;
          },
          async stop() {
            running = false;
          },
        },
      ],
    });

    await supervisor.tick();
    await halts.halt("owner stop", NOW);
    await supervisor.tick();
    await halts.resume("continue", new Date(NOW.getTime() + 1_000));
    await assert.rejects(supervisor.tick(), /start failed/u);
    assert.equal(running, false);

    await supervisor.tick();
    assert.equal(running, true);
    assert.equal(starts, 3);
  });

  it("restarts a runtime after its halt stop partially succeeds and fails", async () => {
    let running = false;
    let starts = 0;
    const supervisor = new HaltSupervisor(halts, acks, new RunningExecutionRegistry(), {
      managedRuntimes: [
        {
          async start() {
            starts += 1;
            running = true;
          },
          async stop() {
            running = false;
            throw new Error("partial stop failed");
          },
        },
      ],
    });

    await supervisor.tick();
    await halts.halt("owner stop", NOW);
    await assert.rejects(supervisor.tick(), /partial stop failed/u);
    assert.equal(running, false);
    assert.deepEqual(await acks.read(), { kind: "none" });

    await halts.resume("continue", new Date(NOW.getTime() + 1_000));
    await supervisor.tick();
    assert.equal(running, true);
    assert.equal(starts, 2);
  });

  it("never acknowledges when a managed runtime cannot be stopped", async () => {
    const supervisor = new HaltSupervisor(halts, acks, new RunningExecutionRegistry(), {
      managedRuntimes: [
        {
          async start() {},
          async stop() {
            throw new Error("stop failed");
          },
        },
      ],
    });
    await halts.halt("owner stop", NOW);
    await assert.rejects(supervisor.tick(), /stop failed/u);
    assert.deepEqual(await acks.read(), { kind: "none" });
  });

  it("binds a new acknowledgement to a new halt record and to a fail-closed halt", async () => {
    const supervisor = new HaltSupervisor(halts, acks, new RunningExecutionRegistry());
    await halts.halt("first", NOW);
    await supervisor.tick();
    await halts.resume("ok", NOW);
    await supervisor.tick();
    const second = await halts.halt("second", new Date(NOW.getTime() + 60_000));
    await supervisor.tick();
    const reading = await acks.read();
    assert.equal(reading.kind === "ack" && reading.ack.haltRef, `record:${second.id}`);

    const haltFile = path.join(directory, HALT_FILE_BASENAME);
    await writeFile(haltFile, "{not json");
    await supervisor.tick();
    const failClosed = await acks.read();
    const firstRef = failClosed.kind === "ack" ? failClosed.ack.haltRef : "";
    assert.match(firstRef, /^fail-closed:/);
    assert.equal(firstRef, haltRefFor(await halts.read()), "stable while the file is unchanged");
  });

  it("never matches an old acknowledgement to a new halt written in the same millisecond", async () => {
    await halts.halt("first", NOW);
    await new HaltSupervisor(halts, acks, new RunningExecutionRegistry()).tick();
    // Same timestamp and reason; the service is gone and never sees this one.
    await halts.halt("first", NOW);
    const out: string[] = [];
    await runSecurityHalt(
      ["status"],
      halts,
      { out: (l) => out.push(l), err: () => undefined },
      acks,
    );
    assert.match(out.join("\n"), /not acknowledged yet/);
    assert.doesNotMatch(out.join("\n"), /VERIFIED STOPPED/);
  });

  it("still binds a record written before ids existed by its changedAt", async () => {
    await writeFile(
      path.join(directory, HALT_FILE_BASENAME),
      JSON.stringify({
        version: 1,
        state: "requested",
        changedAt: NOW.toISOString(),
        changedBy: "owner-cli",
        reason: "legacy",
      }),
    );
    const reading = await halts.read();
    assert.equal(reading.halted, true);
    assert.equal(haltRefFor(reading), `record:${NOW.toISOString()}`);
  });

  it("never matches an old fail-closed acknowledgement to a later fail-closed halt", async () => {
    const haltFile = path.join(directory, HALT_FILE_BASENAME);
    await writeFile(haltFile, "{not json");
    await new HaltSupervisor(halts, acks, new RunningExecutionRegistry()).tick();
    assert.equal((await acks.read()).kind, "ack");

    // The service is gone; the record is replaced by a different unreadable one.
    await rm(haltFile);
    await writeFile(haltFile, "{still not json");
    const later = await halts.read();
    assert.equal(later.halted, true);
    const out: string[] = [];
    await runSecurityHalt(
      ["status"],
      halts,
      { out: (l) => out.push(l), err: () => undefined },
      acks,
    );
    assert.match(out.join("\n"), /not acknowledged yet/);
    assert.doesNotMatch(out.join("\n"), /VERIFIED STOPPED/);
  });

  it("cancels but never acknowledges a fail-closed halt it cannot identify", async () => {
    const registry = new RunningExecutionRegistry();
    const run = registry.begin();
    const unidentified = new FileHaltStore(path.join(directory, HALT_FILE_BASENAME));
    unidentified.read = async () => ({ halted: true, record: null, failClosed: "unstatable" });
    await new HaltSupervisor(unidentified, acks, registry).tick();
    assert.equal(run.signal.aborted, true);
    assert.deepEqual(await acks.read(), { kind: "none" });
    const out: string[] = [];
    await runSecurityHalt(
      ["status"],
      unidentified,
      { out: (l) => out.push(l), err: () => undefined },
      acks,
    );
    assert.match(out.join("\n"), /cannot be verified/);
  });

  it("reads an invalid acknowledgement as unreadable", async () => {
    await writeFile(ackPath, JSON.stringify({ version: 1, haltRef: "x" }));
    assert.equal((await acks.read()).kind, "unreadable");
  });
});

describe("npm run sec reports requested, acknowledged and verified stopped", () => {
  function io(sleep?: (ms: number) => Promise<void>) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      sink: {
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
        now: () => NOW,
        ...(sleep === undefined ? {} : { sleep }),
      },
    };
  }

  it("halt waits for the service and prints verified stopped", async () => {
    const supervisor = new HaltSupervisor(halts, acks, new RunningExecutionRegistry(), {
      pid: 99,
    });
    const x = io(() => supervisor.tick());
    assert.equal(await runSecurityHalt(["halt", "owner stop"], halts, x.sink, acks), 0);
    const text = x.out.join("\n");
    assert.match(text, /HALTED \(requested 2026-11-21T01:00:00.000Z: owner stop\)/);
    assert.match(text, /Service \(pid 99\): VERIFIED STOPPED/);
    assert.match(text, /0 governed executions cancelled/);
  });

  it("reports not acknowledged when no service answers, or the ack is for another halt", async () => {
    const x = io();
    await halts.halt("owner stop", NOW);
    assert.equal(await runSecurityHalt(["status"], halts, x.sink, acks), 0);
    assert.match(x.out.join("\n"), /not acknowledged yet/);
    assert.match(x.out.join("\n"), /Not a verified stop/);

    const supervisor = new HaltSupervisor(halts, acks, new RunningExecutionRegistry());
    await supervisor.tick();
    await halts.halt("again", new Date(NOW.getTime() + 60_000));
    const y = io();
    await runSecurityHalt(["status"], halts, y.sink, acks);
    assert.match(y.out.join("\n"), /not acknowledged yet/);
  });

  it("reports waiting while an effect is unsettled, and an unreadable ack", async () => {
    const registry = new RunningExecutionRegistry();
    const run = registry.begin();
    run.trackEffect(new Promise(() => undefined));
    registry.end(run);
    await halts.halt("owner stop", NOW);
    await new HaltSupervisor(halts, acks, registry, { pid: 7 }).tick();
    const x = io();
    await runSecurityHalt(["status"], halts, x.sink, acks);
    assert.match(
      x.out.join("\n"),
      /Service \(pid 7\): acknowledged .*1 governed execution cancelled/,
    );
    assert.match(x.out.join("\n"), /Waiting for 1 effect to settle/);

    await writeFile(ackPath, "garbage");
    const y = io();
    await runSecurityHalt(["status"], halts, y.sink, acks);
    assert.match(y.out.join("\n"), /NOT ACKNOWLEDGED \(acknowledgement file is not valid JSON\)/);
  });

  it("does not report a stale acknowledgement after resume", async () => {
    await halts.halt("owner stop", NOW);
    await new HaltSupervisor(halts, acks, new RunningExecutionRegistry()).tick();
    const x = io();
    await runSecurityHalt(["resume", "checked"], halts, x.sink, acks);
    assert.equal(
      x.out.join("\n"),
      "Dispatch: running (resumed 2026-11-21T01:00:00.000Z: checked).",
    );
  });
});
