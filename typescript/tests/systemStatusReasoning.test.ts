import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import { resolveHttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

const SERVICE_TOKEN = "issue435-service-token-0000000000000001";
const PROVIDER_SECRET = "issue435-provider-secret-never-return-this";
const AUTH = { authorization: `Bearer ${SERVICE_TOKEN}` };
const openApps: NestFastifyApplication[] = [];

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

async function statusFor(
  env: NodeJS.ProcessEnv,
): Promise<{ body: string; payload: Record<string, unknown> }> {
  const app = await createJarvisHttpApp({
    persistence: minimalPersistence(),
    providerName: "json",
    config: resolveHttpAppConfig({
      JARVIS_SOURCE_VERSION: "issue435-status-test",
      JARVIS_TIMEZONE: "Australia/Melbourne",
      JARVIS_SERVICE_TOKEN: SERVICE_TOKEN,
      ...env,
    }),
    logger: false,
  });
  openApps.push(app);

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/status",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  return { body: response.body, payload: response.json() as Record<string, unknown> };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("system status reasoning configuration projection", () => {
  it("reports a trusted configured identity without claiming a successful invocation or exposing the credential", async () => {
    const { body, payload } = await statusFor({
      TOTALITY_REASONER_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.6-terra",
      OPENAI_API_KEY: PROVIDER_SECRET,
    });

    assert.deepEqual(payload.reasoning, {
      configurationState: "configured",
      provider: "openai",
      model: "gpt-5.6-terra",
      invocationState: "unverified",
    });
    assert.equal(body.includes(PROVIDER_SECRET), false);
  });

  it("reports not-configured when the selected provider has no credential", async () => {
    const { payload } = await statusFor({
      TOTALITY_REASONER_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.6-terra",
    });

    assert.deepEqual(payload.reasoning, {
      configurationState: "not-configured",
      provider: "openai",
      model: "gpt-5.6-terra",
      invocationState: "unverified",
      reason: "The selected reasoning provider is missing its server-side credential.",
    });
  });

  it("reports unavailable when the configured identity is absent from the trusted model registry", async () => {
    const { payload } = await statusFor({
      TOTALITY_REASONER_PROVIDER: "openai",
      OPENAI_MODEL: "unregistered-model",
      OPENAI_API_KEY: PROVIDER_SECRET,
    });

    assert.deepEqual(payload.reasoning, {
      configurationState: "unavailable",
      provider: "openai",
      model: "unregistered-model",
      invocationState: "unverified",
      reason: "The configured reasoning identity is not present in the trusted model registry.",
    });
  });
});
