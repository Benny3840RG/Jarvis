import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { z } from "zod";

import { ToolExecutionService } from "../src/actions/toolExecution.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { IntegrationStatus, LayersStatus } from "../src/http/contracts.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { IMMUTABLE_SAFETY_CATEGORIES } from "../src/safety/safetyBinder.js";

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

async function fetchLayers(app: NestFastifyApplication): Promise<LayersStatus> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/status",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  return (response.json() as { layers: LayersStatus }).layers;
}

const CATEGORY_COUNT_WORDS: Record<number, string> = {
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
};

describe("system status integration commissioning evidence", () => {
  it("reports quote-delivery as implemented-only with a reason when tool execution is unconfigured", async () => {
    const app = await makeApp(null);
    const integrations = await fetchIntegrations(app);
    const quoteDelivery = integrations.find((entry) => entry.name === "quote-delivery");
    assert.equal(quoteDelivery?.stage, "implemented");
    assert.equal(quoteDelivery?.status, "not-commissioned");
    assert.ok(quoteDelivery?.reason);
  });

  it("reports quote-delivery as implemented-only with a reason when quotes:send is not registered", async () => {
    const app = await makeApp(new ToolExecutionService([]));
    const integrations = await fetchIntegrations(app);
    const quoteDelivery = integrations.find((entry) => entry.name === "quote-delivery");
    assert.equal(quoteDelivery?.stage, "implemented");
    assert.equal(quoteDelivery?.status, "not-commissioned");
    assert.ok(quoteDelivery?.reason);
  });

  it("treats a registered quotes:send as configured only — registration never implies commissioning", async () => {
    const app = await makeApp(quoteSendRegisteredService());
    const integrations = await fetchIntegrations(app);
    const quoteDelivery = integrations.find((entry) => entry.name === "quote-delivery");
    // Registration proves the dependency bundle is wired. It proves nothing
    // about the live provider ever being reached, and carries no operator
    // approval, so the reported stage stops at "configured".
    assert.equal(quoteDelivery?.stage, "configured");
    assert.equal(quoteDelivery?.status, "not-commissioned");
    assert.match(
      quoteDelivery?.reason ?? "",
      /No commissioning or production-approval evidence reader is wired/,
    );
    assert.doesNotMatch(quoteDelivery?.reason ?? "", /No commissioning evidence exists/);
  });

  it("is a live evidence check, not a fabricated constant — the stage flips with the actual registered service", async () => {
    const unregistered = await fetchIntegrations(await makeApp(new ToolExecutionService([])));
    const registered = await fetchIntegrations(await makeApp(quoteSendRegisteredService()));

    assert.equal(
      unregistered.find((entry) => entry.name === "quote-delivery")?.stage,
      "implemented",
    );
    assert.equal(registered.find((entry) => entry.name === "quote-delivery")?.stage, "configured");
  });

  it("never derives a commissioned status from a stage weaker than commissioned", async () => {
    for (const service of [null, new ToolExecutionService([]), quoteSendRegisteredService()]) {
      const integrations = await fetchIntegrations(await makeApp(service));
      for (const integration of integrations) {
        const derived =
          integration.stage === "commissioned" || integration.stage === "production-approved"
            ? "commissioned"
            : "not-commissioned";
        assert.equal(
          integration.status,
          derived,
          `${integration.name}: status must be derived from stage, never asserted independently`,
        );
      }
    }
  });

  it("keeps the safety layer's reported category count in sync with IMMUTABLE_SAFETY_CATEGORIES", async () => {
    // Regression guard: this text previously said "five" after a sixth
    // category (tool-action) was added and the static status string was
    // never updated. This doesn't verify the substantive "not yet bound to
    // every transition" claim -- only that the count can't silently drift
    // from the real category list again.
    const layers = await fetchLayers(await makeApp(null));
    const word = CATEGORY_COUNT_WORDS[IMMUTABLE_SAFETY_CATEGORIES.length];
    assert.ok(
      word,
      `add a CATEGORY_COUNT_WORDS entry for ${IMMUTABLE_SAFETY_CATEGORIES.length} categories`,
    );
    assert.ok(
      layers.safety.reason?.includes(`all ${word} immutable safety categories`),
      `expected the safety reason to say "all ${word} immutable safety categories", got: ${layers.safety.reason}`,
    );
  });
});
