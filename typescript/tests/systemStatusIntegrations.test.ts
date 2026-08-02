import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { z } from "zod";

import { ToolExecutionService } from "../src/actions/toolExecution.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { IntegrationStatus } from "../src/http/contracts.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "system-status-integrations-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
};

const AUTH = { authorization: "Bearer current-secret" };
const openApps: NestFastifyApplication[] = [];

function quoteSendRegisteredService(): ToolExecutionService {
  return new ToolExecutionService([
    {
      tool: "quotes",
      operation: "send",
      schema: z.object({}),
      async execute() {
        return {};
      },
    },
  ]);
}

function minimalPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("must not be reached");
  };
  return {
    async loadState() {
      return {};
    },
    async listTasks() {
      return [];
    },
    async listReminders() {
      return [];
    },
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
    saveState: forbidden,
  };
}

async function makeApp(
  toolExecutionService: ToolExecutionService | null,
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: minimalPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    toolExecutionService,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function fetchIntegrations(app: NestFastifyApplication): Promise<IntegrationStatus[]> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/status",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  return (response.json() as { integrations: IntegrationStatus[] }).integrations;
}

describe("system status integration commissioning evidence", () => {
  it("reports quote-delivery as not-commissioned with a reason when tool execution is unconfigured", async () => {
    const app = await makeApp(null);
    const integrations = await fetchIntegrations(app);
    const quoteDelivery = integrations.find((entry) => entry.name === "quote-delivery");
    assert.equal(quoteDelivery?.status, "not-commissioned");
    assert.ok(quoteDelivery?.reason);
  });

  it("reports quote-delivery as not-commissioned with a reason when quotes:send is not registered", async () => {
    const app = await makeApp(new ToolExecutionService([]));
    const integrations = await fetchIntegrations(app);
    const quoteDelivery = integrations.find((entry) => entry.name === "quote-delivery");
    assert.equal(quoteDelivery?.status, "not-commissioned");
    assert.ok(quoteDelivery?.reason);
  });

  it("reports quote-delivery as commissioned, with no reason, once quotes:send is actually registered", async () => {
    const app = await makeApp(quoteSendRegisteredService());
    const integrations = await fetchIntegrations(app);
    const quoteDelivery = integrations.find((entry) => entry.name === "quote-delivery");
    assert.equal(quoteDelivery?.status, "commissioned");
    assert.equal("reason" in (quoteDelivery ?? {}), false);
  });

  it("is a live evidence check, not a fabricated constant — it flips with the actual registered service", async () => {
    const uncommissioned = await fetchIntegrations(await makeApp(new ToolExecutionService([])));
    const commissioned = await fetchIntegrations(await makeApp(quoteSendRegisteredService()));

    assert.equal(
      uncommissioned.find((entry) => entry.name === "quote-delivery")?.status,
      "not-commissioned",
    );
    assert.equal(
      commissioned.find((entry) => entry.name === "quote-delivery")?.status,
      "commissioned",
    );
  });
});
