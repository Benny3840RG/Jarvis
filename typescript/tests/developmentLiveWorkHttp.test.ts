import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { DevelopmentLiveWorkSource, LiveWorkSnapshot } from "../src/development/liveWork.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "development-live-work-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
};

const AUTH = { authorization: "Bearer current-secret" };
const openApps: NestFastifyApplication[] = [];

function forbiddenPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("must not be reached");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: forbidden,
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

function sampleSnapshot(): LiveWorkSnapshot {
  return {
    subject: {
      subjectId: "mission-1",
      state: "REVIEW",
      repository: "Benny3840RG/Jarvis",
      branch: "agent/mission-1",
      updatedAt: Date.parse("2026-09-01T00:00:00.000Z"),
    },
    events: [],
    omegaMission: {
      missionId: "mission-1",
      objective: "Ship the live-work HUD",
      state: "active",
      acceptanceCriteria: [{ status: "satisfied" }],
    },
    workerStep: null,
    generatedAt: "2026-09-01T01:00:00.000Z",
  };
}

async function makeApp(
  developmentLiveWorkSource: DevelopmentLiveWorkSource | null,
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: forbiddenPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    developmentLiveWorkSource,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("development live-work HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp(null);
    const response = await app.inject({ method: "GET", url: "/api/v1/development/live-work" });
    assert.equal(response.statusCode, 401);
  });

  it("reports unavailable, not an empty pipeline, when no source is configured", async () => {
    const app = await makeApp(null);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/development/live-work",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: { status: string; reason?: string } };
    assert.equal(body.data.status, "unavailable");
    assert.match(body.data.reason ?? "", /Convex/);
  });

  it("reports available idle when the source has no mission in flight", async () => {
    const app = await makeApp({ readLiveWorkSnapshot: async () => null });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/development/live-work",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: { status: string; reason?: string } };
    assert.deepEqual(body.data, { status: "available", pipeline: null });
  });

  it("folds the source snapshot into the pipeline", async () => {
    const app = await makeApp({ readLiveWorkSnapshot: async () => sampleSnapshot() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/development/live-work",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: {
        status: string;
        pipeline: { objective: string; nodes: { key: string; status: string }[] };
      };
    };
    assert.equal(body.data.status, "available");
    assert.equal(body.data.pipeline.objective, "Ship the live-work HUD");
    assert.deepEqual(
      body.data.pipeline.nodes.map((node) => node.key),
      ["mission", "stage", "issue", "pr", "worker", "review", "ci", "merge", "omega"],
    );
    assert.equal(body.data.pipeline.nodes.find((node) => node.key === "review")?.status, "active");
  });

  it("reports unavailable, not an error, when the source throws", async () => {
    const app = await makeApp({
      readLiveWorkSnapshot: async () => {
        throw new Error("convex offline");
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/development/live-work",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: { status: string } };
    assert.equal(body.data.status, "unavailable");
  });
});

// An absent worker is null; a present worker identifies its persisted node/state.
it("OpenAPI worker step rejects empty and undocumented records", () => {
  const contract = JSON.parse(
    readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
  );
  const schema = contract.components.schemas.LiveWorkPipeline.properties.workerStep;
  const validate = new Ajv2020.default({ strict: false }).compile(schema);
  assert.equal(validate(null), true);
  assert.equal(validate({ nodeId: "node-1", state: "running" }), true);
  for (const value of [
    {},
    { nodeId: "node-1" },
    { state: "running" },
    { nodeId: "node-1", state: "running", leaseToken: "not-public" },
  ]) {
    assert.equal(validate(value), false);
  }
});
