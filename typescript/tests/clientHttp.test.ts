import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Client } from "../src/clients/client.js";
import type { EnquiryStore } from "../src/enquiries/enquiry.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "client-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in client HTTP tests");
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

describe("client HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/clients")).statusCode, 401);
  });

  it("creates, lists, gets, updates, and deletes a client", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/clients", {
      headers: AUTH,
      payload: { name: "Acme Joinery", contacts: [{ label: "mobile", value: "0400 000 000" }] },
    });
    assert.equal(created.statusCode, 201);
    const client = created.json<{ data: Client }>().data;
    assert.equal(client.name, "Acme Joinery");
    assert.equal(client.contacts[0].value, "0400 000 000");

    const list = await inject(app, "GET", "/api/v1/clients", { headers: AUTH });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json<{ count: number }>().count, 1);

    const fetched = await inject(app, "GET", `/api/v1/clients/${client.id}`, { headers: AUTH });
    assert.equal(fetched.statusCode, 200);

    const updated = await inject(app, "PATCH", `/api/v1/clients/${client.id}`, {
      headers: AUTH,
      payload: { notes: "Prefers email" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json<{ data: Client }>().data.notes, "Prefers email");

    const removed = await inject(app, "DELETE", `/api/v1/clients/${client.id}`, { headers: AUTH });
    assert.equal(removed.statusCode, 200);
    assert.equal(
      (await inject(app, "GET", `/api/v1/clients/${client.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("refuses to delete a client that an enquiry or invoice draft still references", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/clients", {
      headers: AUTH,
      payload: { name: "Referenced Client" },
    });
    const clientId = created.json<{ data: Client }>().data.id;

    const enquiry = await inject(app, "POST", "/api/v1/enquiries", {
      headers: AUTH,
      payload: {
        clientId,
        source: "phone",
        requestedWork: "Fictional hedge cut",
      },
    });
    assert.equal(enquiry.statusCode, 201);

    const blockedByEnquiry = await inject(app, "DELETE", `/api/v1/clients/${clientId}`, {
      headers: AUTH,
    });
    assert.equal(blockedByEnquiry.statusCode, 409);
    assert.equal(blockedByEnquiry.json().type, "urn:jarvis:problem:client-still-referenced");
    assert.match(blockedByEnquiry.json().detail, /enquiry/);
    assert.equal(
      (await inject(app, "GET", `/api/v1/clients/${clientId}`, { headers: AUTH })).statusCode,
      200,
    );

    const invoiceClient = await inject(app, "POST", "/api/v1/clients", {
      headers: AUTH,
      payload: { name: "Invoice Client" },
    });
    const invoiceClientId = invoiceClient.json<{ data: Client }>().data.id;
    const invoice = await inject(app, "POST", "/api/v1/invoices", {
      headers: AUTH,
      payload: {
        clientId: invoiceClientId,
        number: "INV-DRAFT-1",
        lineItems: [{ description: "Probe", quantity: 1, unitPrice: 10 }],
      },
    });
    assert.equal(invoice.statusCode, 201);
    assert.equal(invoice.json<{ data: { status: string } }>().data.status, "draft");

    const blockedByInvoice = await inject(app, "DELETE", `/api/v1/clients/${invoiceClientId}`, {
      headers: AUTH,
    });
    assert.equal(blockedByInvoice.statusCode, 409);
    assert.match(blockedByInvoice.json().detail, /invoice/);
    assert.equal(
      (await inject(app, "GET", `/api/v1/clients/${invoiceClientId}`, { headers: AUTH }))
        .statusCode,
      200,
    );
  });

  it("refuses to delete a client that a property or project still references", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/clients", {
      headers: AUTH,
      payload: { name: "Site Client" },
    });
    const clientId = created.json<{ data: Client }>().data.id;
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/properties", {
          headers: AUTH,
          payload: { clientId, address: "1 Fictional Grove" },
        })
      ).statusCode,
      201,
    );
    const blockedByProperty = await inject(app, "DELETE", `/api/v1/clients/${clientId}`, {
      headers: AUTH,
    });
    assert.equal(blockedByProperty.statusCode, 409);
    assert.match(blockedByProperty.json().detail, /property/);

    const jobClient = await inject(app, "POST", "/api/v1/clients", {
      headers: AUTH,
      payload: { name: "Job Client" },
    });
    const jobClientId = jobClient.json<{ data: Client }>().data.id;
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/projects", {
          headers: AUTH,
          payload: { clientId: jobClientId, title: "Fictional job", scheduledFor: "2026-10-14" },
        })
      ).statusCode,
      201,
    );
    const blockedByProject = await inject(app, "DELETE", `/api/v1/clients/${jobClientId}`, {
      headers: AUTH,
    });
    assert.equal(blockedByProject.statusCode, 409);
    assert.match(blockedByProject.json().detail, /project/);
  });

  it("fails closed when a referencing ledger cannot be read", async () => {
    const unused = async (): Promise<never> => {
      throw new Error("unused in client deletion HTTP test");
    };
    const enquiryStore: EnquiryStore = {
      list: () => Promise.reject(new Error("enquiry ledger unreadable")),
      get: unused,
      add: unused,
      update: unused,
      close: unused,
      convertToProject: unused,
    };
    const app = await createJarvisHttpApp({
      persistence: unusedPersistence(),
      providerName: "json",
      config: CONFIG,
      logger: false,
      enquiryStore,
    });
    openApps.push(app);
    const created = await inject(app, "POST", "/api/v1/clients", {
      headers: AUTH,
      payload: { name: "Unreadable Ledger" },
    });
    const clientId = created.json<{ data: Client }>().data.id;

    const blocked = await inject(app, "DELETE", `/api/v1/clients/${clientId}`, {
      headers: AUTH,
    });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().type, "urn:jarvis:problem:client-persistence-failed");
    assert.equal(
      (await inject(app, "GET", `/api/v1/clients/${clientId}`, { headers: AUTH })).statusCode,
      200,
    );
  });

  it("rejects an invalid create body and an unknown id", async () => {
    const app = await makeApp();
    assert.equal(
      (await inject(app, "POST", "/api/v1/clients", { headers: AUTH, payload: {} })).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/clients/nope", { headers: AUTH })).statusCode,
      404,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/clients/x", { headers: AUTH, payload: {} })).statusCode,
      422,
    );
  });
});
