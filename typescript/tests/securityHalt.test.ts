import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { z } from "zod";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  EXECUTION_LEASE_RENEW_MS,
  InMemoryExecutionEligibilityStore,
  InMemoryToolExecutionReceiptStore,
  ToolExecutionService,
  type SingleUseConsumptionClaimStore,
} from "../src/actions/toolExecution.js";
import {
  FileHaltStore,
  HALT_FILE_BASENAME,
  haltGateFromStore,
  normalizeHaltReason,
} from "../src/security/haltControl.js";
import { describeHalt, runSecurityHalt } from "../src/tools/runSecurityHalt.js";

const NOW = new Date("2026-11-20T01:00:00.000Z");

let directory = "";
let haltPath = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "nolan-halt-"));
  haltPath = path.join(directory, HALT_FILE_BASENAME);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function action(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "action-halt-1",
    requestId: "request-halt-1",
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool: "notes",
    operation: "create",
    arguments: { text: "hello" },
    rationale: "Write a note.",
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: "proposal-halt-1",
    proposedBy: "user",
    approvedBy: "user",
    consumptionPolicy: "single-use",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

class CountingClaims implements SingleUseConsumptionClaimStore {
  calls = 0;
  async claim(_action: ToolAction, claimId: string) {
    this.calls += 1;
    return { claimed: true, claimId };
  }
}

function service(gate: () => Promise<boolean>) {
  const counts = { executions: 0, preflights: 0 };
  const claims = new CountingClaims();
  const executor = new ToolExecutionService(
    [
      {
        tool: "notes",
        operation: "create",
        schema: z.object({ text: z.string() }),
        async preflight() {
          counts.preflights += 1;
        },
        async execute() {
          counts.executions += 1;
          return { ok: true };
        },
      },
    ],
    new InMemoryToolExecutionReceiptStore(),
    undefined,
    claims,
    new InMemoryExecutionEligibilityStore(),
    EXECUTION_LEASE_RENEW_MS,
    gate,
  );
  return { executor, counts, claims };
}

describe("halt record", () => {
  it("reads a missing record as running", async () => {
    const reading = await new FileHaltStore(haltPath).read();
    assert.deepEqual(reading, { halted: false, record: null });
  });

  it("halts and resumes with an owner-only private record", async () => {
    const store = new FileHaltStore(haltPath);
    const halted = await store.halt("  suspicious\nactivity ", NOW);
    assert.equal(halted.state, "requested");
    assert.equal(halted.reason, "suspicious activity");
    assert.equal(halted.changedBy, "owner-cli");
    assert.equal((await stat(haltPath)).mode & 0o777, 0o600);
    assert.deepEqual(await store.read(), { halted: true, record: halted });

    const resumed = await store.resume("checked", NOW);
    assert.equal(resumed.state, "none");
    assert.deepEqual(await store.read(), { halted: false, record: resumed });
  });

  it("fails closed on invalid JSON, unknown shapes, oversize files and symlinks", async () => {
    const store = new FileHaltStore(haltPath);
    await writeFile(haltPath, "{not json");
    assert.equal((await store.read()).halted, true);

    await writeFile(
      haltPath,
      JSON.stringify({
        version: 1,
        state: "none",
        changedAt: NOW.toISOString(),
        changedBy: "owner-cli",
        reason: "ok",
        extra: true,
      }),
    );
    const unknown = await store.read();
    assert.equal(unknown.halted, true);
    assert.equal(unknown.halted && unknown.failClosed, "halt record has an unknown shape");

    await writeFile(haltPath, " ".repeat(5000));
    assert.equal((await store.read()).halted, true);

    await rm(haltPath);
    const target = path.join(directory, "elsewhere.json");
    await writeFile(
      target,
      JSON.stringify({
        version: 1,
        state: "none",
        changedAt: NOW.toISOString(),
        changedBy: "owner-cli",
        reason: "ok",
      }),
    );
    await symlink(target, haltPath);
    assert.equal((await store.read()).halted, true);
  });

  it("fails closed when the record path is a directory", async () => {
    const store = new FileHaltStore(directory);
    assert.equal((await store.read()).halted, true);
  });

  it("refuses relative paths and empty or overlong reasons", async () => {
    assert.throws(() => new FileHaltStore("data/halt.json"), /absolute/);
    assert.throws(() => normalizeHaltReason(" \n\t "), /required/);
    assert.throws(() => normalizeHaltReason("x".repeat(281)), /at most 280/);
    await assert.rejects(new FileHaltStore(haltPath).halt("", NOW), /required/);
  });

  it("treats a throwing store as halted through the gate", async () => {
    const store = new FileHaltStore(haltPath);
    store.read = async () => {
      throw new Error("disk gone");
    };
    assert.equal(await haltGateFromStore(store)(), true);
  });
});

describe("halt dispatch gate", () => {
  it("refuses dispatch while halted without preflight, claim or effect", async () => {
    const store = new FileHaltStore(haltPath);
    await store.halt("owner stop", NOW);
    const { executor, counts, claims } = service(haltGateFromStore(store));

    const blocked = await executor.execute({
      action: action(),
      authority: "T1",
      idempotencyKey: "attempt-1",
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.errorCode, "safety-blocked");
    assert.deepEqual(counts, { executions: 0, preflights: 0 });
    assert.equal(claims.calls, 0);

    // Nothing was consumed: after resume the same action and key run once.
    await store.resume("all clear", NOW);
    const ran = await executor.execute({
      action: action(),
      authority: "T1",
      idempotencyKey: "attempt-1",
    });
    assert.equal(ran.status, "succeeded");
    assert.deepEqual(counts, { executions: 1, preflights: 1 });
    assert.equal(claims.calls, 1);
  });

  it("keeps dry runs available while halted", async () => {
    const { executor, counts } = service(async () => true);
    const dry = await executor.execute({
      action: action(),
      authority: "T1",
      idempotencyKey: "dry-1",
      dryRun: true,
    });
    assert.equal(dry.status, "dry-run");
    assert.equal(counts.executions, 0);
  });

  it("fails closed when the gate throws or returns a non-false value", async () => {
    for (const gate of [
      async () => {
        throw new Error("unreadable");
      },
      async () => undefined as unknown as boolean,
    ]) {
      const { executor, counts } = service(gate);
      const result = await executor.execute({
        action: action(),
        authority: "T1",
        idempotencyKey: "gate-failure",
      });
      assert.equal(result.errorCode, "safety-blocked");
      assert.equal(counts.executions, 0);
    }
  });

  it("does not gate a service built without a halt gate", async () => {
    const executor = new ToolExecutionService([
      {
        tool: "notes",
        operation: "create",
        schema: z.object({ text: z.string() }),
        async execute() {
          return { ok: true };
        },
      },
    ]);
    const result = await executor.execute({
      action: action({ consumptionPolicy: undefined }),
      authority: "T1",
      idempotencyKey: "no-gate",
    });
    assert.equal(result.status, "succeeded");
  });
});

describe("npm run sec", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      sink: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => NOW },
    };
  }

  it("halts, reports status and resumes", async () => {
    const store = new FileHaltStore(haltPath);
    const a = io();
    assert.equal(await runSecurityHalt(["halt", "owner stop"], store, a.sink), 0);
    assert.match(a.out.join("\n"), /HALTED \(requested 2026-11-20T01:00:00.000Z: owner stop\)/);
    assert.match(a.out.join("\n"), /not a verified stop/);

    const b = io();
    assert.equal(await runSecurityHalt(["status"], store, b.sink), 0);
    assert.match(b.out.join("\n"), /HALTED/);

    const c = io();
    assert.equal(await runSecurityHalt(["resume", "checked"], store, c.sink), 0);
    assert.match(c.out.join("\n"), /running \(resumed/);
    const saved = JSON.parse(await readFile(haltPath, "utf8")) as { state: string };
    assert.equal(saved.state, "none");
  });

  it("prints usage for unknown or malformed commands and reports errors", async () => {
    const store = new FileHaltStore(haltPath);
    for (const argv of [[], ["stop"], ["halt"], ["halt", "a", "b"], ["status", "x"]]) {
      const x = io();
      assert.equal(await runSecurityHalt(argv, store, x.sink), 2);
      assert.match(x.err.join("\n"), /Usage:/);
    }
    const y = io();
    assert.equal(await runSecurityHalt(["halt", "   "], store, y.sink), 1);
    assert.match(y.err.join("\n"), /required/);
  });

  it("describes a fail-closed record", () => {
    assert.match(
      describeHalt({ halted: true, record: null, failClosed: "halt record is not valid JSON" }),
      /HALTED \(fail closed: halt record is not valid JSON\)/,
    );
    assert.equal(
      describeHalt({ halted: false, record: null }),
      "Dispatch: running (no halt record).",
    );
  });
});
