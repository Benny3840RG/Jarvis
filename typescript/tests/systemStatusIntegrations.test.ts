import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { z } from "zod";

import { ToolExecutionService } from "../src/actions/toolExecution.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { IntegrationStatus, ReasoningConfigurationStatus } from "../src/http/contracts.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { TotalityPipeline } from "../src/totality/totalityPipeline.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "system-status-integrations-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
};

const AUTH = { authorization: ["Bearer", CONFIG.currentToken ?? ""].join(" ") };
const openApps: NestFastifyApplication[] = [];
const ENV_KEYS = [
  "TOTALITY_REASONER_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
] as const;
const originalEnv = new Map<string, string | undefined>();

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
  providerName: "json" | "convex" = "json",
  totalityPipeline: TotalityPipeline | null = null,
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: minimalPersistence(),
    providerName,
    config: CONFIG,
    logger: false,
    totalityPipeline,
    toolExecutionService,
  });
  openApps.push(app);
  return app;
}

beforeEach(() => {
  originalEnv.clear();
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

async function fetchReasoning(app: NestFastifyApplication): Promise<ReasoningConfigurationStatus> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/status",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  return (response.json() as { reasoning: ReasoningConfigurationStatus }).reasoning;
}

describe("system status integration commissioning evidence", () => {
  const configuredPipeline = new TotalityPipeline(
    {
      async reason() {
        throw new Error("must not be reached");
      },
    },
    {
      async getProjectContext() {
        throw new Error("must not be reached");
      },
      async commitOutcome() {
        throw new Error("must not be reached");
      },
    },
  );

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

  it("projects the trusted reasoning provider/model from runtime configuration when Totality is configured", async () => {
    process.env.TOTALITY_REASONER_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "gpt-5.6-terra";

    const reasoning = await fetchReasoning(
      await makeApp(quoteSendRegisteredService(), "convex", configuredPipeline),
    );

    assert.deepEqual(reasoning, {
      status: "configured",
      provider: "openai",
      model: "gpt-5.6-terra",
      observability: "configuration-only",
    });
  });

  it("reports reasoning as not configured when the required runtime configuration is unavailable", async () => {
    delete process.env.TOTALITY_REASONER_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;

    const reasoning = await fetchReasoning(await makeApp(null));

    assert.deepEqual(reasoning, {
      status: "not-configured",
      reason: "Totality reasoning requires the configured Convex persistence provider.",
      observability: "configuration-only",
    });
  });
});
