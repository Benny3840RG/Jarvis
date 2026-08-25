import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import type { BusinessSettings } from "../src/businessSettings/businessSettings.js";

type InjectMethod = "GET" | "PATCH";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "business-settings-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in business settings HTTP tests");
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

const openApps: NestFastifyApplication[] = [];

async function makeApp(): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: unusedPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
  });
  openApps.push(app);
  return app;
}

function inject(
  app: NestFastifyApplication,
  method: InjectMethod,
  url: string,
  options: { headers?: Record<string, string>; payload?: object } = {},
) {
  return app.inject({
    method,
    url,
    headers: { ...(options.headers ?? {}) },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("business settings HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/business-settings")).statusCode, 401);
  });

  it("gets defaults and updates safe Australian business settings", async () => {
    const app = await makeApp();

    const defaults = await inject(app, "GET", "/api/v1/business-settings", { headers: AUTH });
    assert.equal(defaults.statusCode, 200);
    assert.equal(
      defaults.json<{ data: BusinessSettings }>().data.businessName,
      "THE BEEZ TREEZ PROPERTY SOLUTIONS",
    );

    const updated = await inject(app, "PATCH", "/api/v1/business-settings", {
      headers: AUTH,
      payload: {
        gstRegistered: true,
        contactDetails: { email: "admin@beeztreez.example" },
        paymentDetails: { bsb: "123-456", accountNumber: "12345678" },
        pricing: { defaultLabourRateCents: 9000, gstRateBps: 1000 },
        numbering: { quotePrefix: "btq", nextQuoteNumber: 77 },
      },
    });

    assert.equal(updated.statusCode, 200);
    const settings = updated.json<{ data: BusinessSettings }>().data;
    assert.equal(settings.currency, "AUD");
    assert.equal(settings.measurementSystem, "metric");
    assert.equal(settings.contactDetails.email, "admin@beeztreez.example");
    assert.equal(settings.paymentDetails.bsb, "123-456");
    assert.equal(settings.pricing.defaultLabourRateCents, 9000);
    assert.equal(settings.numbering.quotePrefix, "BTQ");
    assert.equal(settings.numbering.nextQuoteNumber, 77);
  });

  it("rejects unknown fields, malformed types, invalid rates, and secret-looking values", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "PATCH", "/api/v1/business-settings", {
          headers: AUTH,
          payload: { currency: "USD" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "PATCH", "/api/v1/business-settings", {
          headers: AUTH,
          payload: { gstRegistered: "yes" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "PATCH", "/api/v1/business-settings", {
          headers: AUTH,
          payload: { pricing: { gstRateBps: 12.5 } },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "PATCH", "/api/v1/business-settings", {
          headers: AUTH,
          payload: { contactDetails: { email: "Bearer abcdefghijklmnop" } },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/business-settings", { headers: AUTH, payload: {} }))
        .statusCode,
      422,
    );
  });
});
