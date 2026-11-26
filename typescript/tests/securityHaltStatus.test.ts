import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { RunningExecutionRegistry } from "../src/actions/runningExecutions.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { SystemStatus } from "../src/http/contracts.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { FileHaltStore, HALT_FILE_BASENAME } from "../src/security/haltControl.js";
import {
  FileHaltAckStore,
  HALT_ACK_FILE_BASENAME,
  HaltSupervisor,
  securityHaltStatusReader,
  summarizeSecurityHalt,
  type SecurityHaltStatus,
} from "../src/security/haltSupervisor.js";

const NOW = new Date("2026-11-21T02:00:00.000Z");
const REASON = "private owner reason 7f3a";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "test-source-0001",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: "previous-secret",
};

const persistence = {
  async loadState() {
    return {};
  },
  async listTasks() {
    return [];
  },
  async listReminders() {
    return [];
  },
} as unknown as PersistenceProvider;

let directory = "";
let halts: FileHaltStore;
let acks: FileHaltAckStore;
const openApps: NestFastifyApplication[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "nolan-halt-status-"));
  halts = new FileHaltStore(path.join(directory, HALT_FILE_BASENAME));
  acks = new FileHaltAckStore(path.join(directory, HALT_ACK_FILE_BASENAME), () => true);
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await rm(directory, { recursive: true, force: true });
});

async function status(securityHaltStatus: () => Promise<SecurityHaltStatus>) {
  const app = await createJarvisHttpApp({
    persistence,
    providerName: "json",
    config: CONFIG,
    logger: false,
    securityHaltStatus,
  });
  openApps.push(app);
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { authorization: "Bearer current-secret" },
    });
  assert.equal(response.statusCode, 200);
  return { body: response.body, json: response.json<SystemStatus>() };
}

describe("security halt read model", () => {
  it("derives running, requested, acknowledged, verified-stopped and unverifiable", async () => {
    assert.equal(summarizeSecurityHalt(await halts.read(), await acks.read()).state, "running");

    const record = await halts.halt(REASON, NOW);
    const requested = summarizeSecurityHalt(await halts.read(), await acks.read());
    assert.deepEqual(requested, {
      state: "requested",
      dispatch: "refused",
      failClosed: false,
      requestedAt: record.changedAt,
      acknowledgedAt: null,
      verifiedStoppedAt: null,
      unsettledExecutions: null,
    });

    const registry = new RunningExecutionRegistry();
    const run = registry.begin();
    let settle!: () => void;
    run.trackEffect(new Promise<void>((resolve) => (settle = resolve)));
    registry.end(run);
    const supervisor = new HaltSupervisor(halts, acks, registry, { now: () => NOW });
    await supervisor.tick();
    const acknowledged = summarizeSecurityHalt(await halts.read(), await acks.read());
    assert.equal(acknowledged.state, "acknowledged");
    assert.equal(acknowledged.unsettledExecutions, 1);

    settle();
    for (let i = 0; i < 50 && registry.unsettled() > 0; i += 1) await Promise.resolve();
    await supervisor.tick();
    const verified = summarizeSecurityHalt(await halts.read(), await acks.read());
    assert.equal(verified.state, "verified-stopped");
    assert.equal(verified.verifiedStoppedAt, NOW.toISOString());

    const unidentified = summarizeSecurityHalt(
      { halted: true, record: null, failClosed: "unstatable" },
      await acks.read(),
    );
    assert.equal(unidentified.state, "unverifiable");
    assert.equal(unidentified.failClosed, true);
    assert.equal(unidentified.dispatch, "refused");
  });

  it("never treats an unreadable acknowledgement as a stop", async () => {
    await halts.halt(REASON, NOW);
    const summary = summarizeSecurityHalt(await halts.read(), {
      kind: "unreadable",
      problem: "is not valid JSON",
    });
    assert.equal(summary.state, "requested");
  });
});

describe("GET /api/v1/status securityHalt", () => {
  it("reports running and ok when there is no halt record", async () => {
    const { json } = await status(securityHaltStatusReader(halts, acks));
    assert.equal(json.securityHalt.state, "running");
    assert.equal(json.securityHalt.dispatch, "allowed");
    assert.equal(json.status, "ok");
  });

  it("reports a verified stop as degraded, without the owner's reason", async () => {
    await halts.halt(REASON, NOW);
    await new HaltSupervisor(halts, acks, new RunningExecutionRegistry(), {
      now: () => NOW,
    }).tick();
    const { json, body } = await status(securityHaltStatusReader(halts, acks));
    assert.equal(json.status, "degraded");
    assert.equal(json.securityHalt.state, "verified-stopped");
    assert.equal(json.securityHalt.dispatch, "refused");
    assert.equal(json.securityHalt.unsettledExecutions, 0);
    assert.doesNotMatch(body, /7f3a/);
  });

  it("fails closed when the halt reader throws", async () => {
    const { json } = await status(async () => {
      throw new Error("disk gone");
    });
    assert.equal(json.status, "degraded");
    assert.deepEqual(json.securityHalt, {
      state: "unverifiable",
      dispatch: "refused",
      failClosed: true,
      requestedAt: null,
      acknowledgedAt: null,
      verifiedStoppedAt: null,
      unsettledExecutions: null,
    });
  });
});
