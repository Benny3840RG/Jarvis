import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Enquiry, EnquiryConversionResult } from "../src/enquiries/enquiry.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "enquiry-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in enquiry HTTP tests");
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

describe("enquiry HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/enquiries")).statusCode, 401);
  });

  it("creates, replays, filters, updates, closes, and converts an enquiry", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/enquiries", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        propertyId: "p1",
        source: "phone",
        requestedWork: "Prune trees near fence",
        duplicateKey: "phone-123",
      },
    });
    assert.equal(created.statusCode, 201);
    const enquiry = created.json<{ data: Enquiry }>().data;
    const replay = await inject(app, "POST", "/api/v1/enquiries", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        source: "email",
        requestedWork: "Different",
        duplicateKey: "phone-123",
      },
    });
    assert.equal(replay.json<{ data: Enquiry }>().data.id, enquiry.id);
    assert.equal(
      (
        await inject(app, "GET", "/api/v1/enquiries?status=open&clientId=c1", { headers: AUTH })
      ).json<{ count: number }>().count,
      1,
    );
    assert.equal(
      (
        await inject(app, "PATCH", `/api/v1/enquiries/${enquiry.id}`, {
          headers: AUTH,
          payload: { urgency: "urgent", safetyNotes: "Power line nearby" },
        })
      ).statusCode,
      200,
    );
    const converted = await inject(app, "POST", `/api/v1/enquiries/${enquiry.id}/convert-project`, {
      headers: AUTH,
      payload: {},
    });
    assert.equal(converted.statusCode, 201);
    const conversion = converted.json<{ data: EnquiryConversionResult }>().data;
    assert.equal(conversion.enquiry.status, "converted");
    assert.equal(conversion.project.clientId, "c1");
    assert.equal(conversion.project.propertyId, "p1");
    const conversionReplay = await inject(
      app,
      "POST",
      `/api/v1/enquiries/${enquiry.id}/convert-project`,
      { headers: AUTH, payload: { title: "Other title" } },
    );
    assert.equal(conversionReplay.json<{ data: EnquiryConversionResult }>().data.replayed, true);
  });

  it("rejects malformed intake, invalid filters, and closed-enquiry conversion", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/enquiries", {
          headers: AUTH,
          payload: { clientId: "c1", source: "phone", requestedWork: "x", price: 1 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/enquiries?status=lost", { headers: AUTH })).statusCode,
      422,
    );
    const created = await inject(app, "POST", "/api/v1/enquiries", {
      headers: AUTH,
      payload: { clientId: "c1", source: "phone", requestedWork: "Hedge trim" },
    });
    const id = created.json<{ data: Enquiry }>().data.id;
    assert.equal(
      (
        await inject(app, "POST", `/api/v1/enquiries/${id}/close`, {
          headers: AUTH,
          payload: { reason: "No response" },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await inject(app, "POST", `/api/v1/enquiries/${id}/convert-project`, {
          headers: AUTH,
          payload: {},
        })
      ).statusCode,
      422,
    );
  });
});
