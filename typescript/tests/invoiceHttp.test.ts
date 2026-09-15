import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Invoice } from "../src/invoices/invoice.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "invoice-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in invoice HTTP tests");
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

describe("invoice HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/invoices")).statusCode, 401);
  });

  it("creates, replays, issues, filters and records invoice payments", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/invoices", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        projectId: "p1",
        quoteId: "q1",
        number: "BTI-0001",
        taxRate: 0.1,
        duplicateKey: "p1-final",
        lineItems: [{ description: "Labour", quantity: 2, unitPrice: 100 }],
      },
    });
    assert.equal(created.statusCode, 201);
    const invoice = created.json<{ data: Invoice }>().data;
    assert.equal(invoice.subtotal, 200);
    assert.equal(invoice.tax, 20);
    assert.equal(invoice.total, 220);
    const replay = await inject(app, "POST", "/api/v1/invoices", {
      headers: AUTH,
      payload: { clientId: "c1", number: "BTI-9999", duplicateKey: "p1-final" },
    });
    assert.equal(replay.json<{ data: Invoice }>().data.id, invoice.id);
    assert.equal(
      (
        await inject(app, "GET", "/api/v1/invoices?clientId=c1&status=draft", { headers: AUTH })
      ).json<{ count: number }>().count,
      1,
    );
    const issued = await inject(app, "POST", `/api/v1/invoices/${invoice.id}/issue`, {
      headers: AUTH,
    });
    assert.equal(issued.statusCode, 201);
    const partial = await inject(app, "POST", `/api/v1/invoices/${invoice.id}/payments`, {
      headers: { ...AUTH, "idempotency-key": "payment-1" },
      payload: { amount: 50, reference: "bank-1" },
    });
    assert.equal(partial.statusCode, 201);
    assert.equal(partial.json<{ data: Invoice }>().data.paymentStatus, "partial");
    const overpaid = await inject(app, "POST", `/api/v1/invoices/${invoice.id}/payments`, {
      headers: { ...AUTH, "idempotency-key": "payment-2" },
      payload: { amount: 200, reference: "bank-2" },
    });
    assert.equal(overpaid.json<{ data: Invoice }>().data.paymentStatus, "overpaid");
  });

  it("does not double-record a payment retried with the same idempotency key", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/invoices", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        number: "BTI-0010",
        lineItems: [{ description: "Labour", quantity: 1, unitPrice: 500 }],
      },
    });
    const invoice = created.json<{ data: Invoice }>().data;
    await inject(app, "POST", `/api/v1/invoices/${invoice.id}/issue`, { headers: AUTH });

    const payload = { amount: 500, reference: "bank-txn-882" };
    const first = await inject(app, "POST", `/api/v1/invoices/${invoice.id}/payments`, {
      headers: { ...AUTH, "idempotency-key": "retry-key-1" },
      payload,
    });
    assert.equal(first.statusCode, 201);
    const firstInvoice = first.json<{ data: Invoice }>().data;
    assert.equal(firstInvoice.payments.length, 1);
    assert.equal(firstInvoice.paymentStatus, "paid");

    // Simulates the client never seeing the first response and retrying with
    // the identical request and idempotency key -- the exact financial-
    // integrity property this fix protects.
    const retry = await inject(app, "POST", `/api/v1/invoices/${invoice.id}/payments`, {
      headers: { ...AUTH, "idempotency-key": "retry-key-1" },
      payload,
    });
    assert.equal(retry.statusCode, 201);
    const retryInvoice = retry.json<{ data: Invoice }>().data;
    assert.equal(retryInvoice.payments.length, 1, "a retried payment must not be recorded twice");
    assert.equal(retryInvoice.amountPaid, 500);
    assert.equal(retryInvoice.paymentStatus, "paid");
    assert.deepEqual(retryInvoice, firstInvoice);
  });

  it("rejects a payment idempotency key reused for a different payment", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/invoices", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        number: "BTI-0011",
        lineItems: [{ description: "Labour", quantity: 1, unitPrice: 500 }],
      },
    });
    const invoice = created.json<{ data: Invoice }>().data;
    await inject(app, "POST", `/api/v1/invoices/${invoice.id}/issue`, { headers: AUTH });

    const first = await inject(app, "POST", `/api/v1/invoices/${invoice.id}/payments`, {
      headers: { ...AUTH, "idempotency-key": "conflict-key" },
      payload: { amount: 100, reference: "bank-a" },
    });
    assert.equal(first.statusCode, 201);

    const conflicting = await inject(app, "POST", `/api/v1/invoices/${invoice.id}/payments`, {
      headers: { ...AUTH, "idempotency-key": "conflict-key" },
      payload: { amount: 200, reference: "bank-b" },
    });
    assert.equal(conflicting.statusCode, 409);
    assert.equal(
      conflicting.json<{ type: string }>().type,
      "urn:jarvis:problem:invoice-payment-idempotency-conflict",
    );

    const unchanged = await inject(app, "GET", `/api/v1/invoices/${invoice.id}`, {
      headers: AUTH,
    });
    assert.equal(unchanged.json<{ data: Invoice }>().data.payments.length, 1);
  });

  it("requires an Idempotency-Key on payment requests", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/invoices", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        number: "BTI-0012",
        lineItems: [{ description: "Labour", quantity: 1, unitPrice: 50 }],
      },
    });
    const invoice = created.json<{ data: Invoice }>().data;
    await inject(app, "POST", `/api/v1/invoices/${invoice.id}/issue`, { headers: AUTH });
    const response = await inject(app, "POST", `/api/v1/invoices/${invoice.id}/payments`, {
      headers: AUTH,
      payload: { amount: 10 },
    });
    assert.equal(response.statusCode, 422);
  });

  it("rejects malformed bodies, stale state changes, pre-issue payment and invalid filters", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/invoices", {
          headers: AUTH,
          payload: { clientId: "c1", number: "BTI-1", total: 1 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/invoices?status=sent", { headers: AUTH })).statusCode,
      422,
    );
    const created = await inject(app, "POST", "/api/v1/invoices", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        number: "BTI-0002",
        lineItems: [{ description: "Waste", quantity: 1, unitPrice: 30 }],
      },
    });
    const invoice = created.json<{ data: Invoice }>().data;
    assert.equal(
      (
        await inject(app, "POST", `/api/v1/invoices/${invoice.id}/payments`, {
          headers: { ...AUTH, "idempotency-key": "pre-issue-payment-attempt" },
          payload: { amount: 10 },
        })
      ).statusCode,
      422,
    );
    await inject(app, "POST", `/api/v1/invoices/${invoice.id}/issue`, { headers: AUTH });
    assert.equal(
      (
        await inject(app, "PATCH", `/api/v1/invoices/${invoice.id}`, {
          headers: AUTH,
          payload: { notes: "late edit" },
        })
      ).statusCode,
      422,
    );
  });
});
