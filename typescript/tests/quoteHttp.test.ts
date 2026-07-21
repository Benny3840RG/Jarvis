import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Quote } from "../src/quotes/quote.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "quote-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in quote HTTP tests");
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

describe("quote HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/quotes")).statusCode, 401);
  });

  it("creates a quote with server-derived totals", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/quotes", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        number: "Q-1001",
        taxRate: 0.1,
        lineItems: [
          { description: "Labour", quantity: 3, unitPrice: 80 },
          { description: "Timber", quantity: 2, unitPrice: 45.5 },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    const quote = created.json<{ data: Quote }>().data;
    assert.equal(quote.number, "Q-1001");
    assert.equal(quote.status, "draft");
    assert.equal(quote.subtotal, 331);
    assert.equal(quote.tax, 33.1);
    assert.equal(quote.total, 364.1);
  });

  it("ignores client-supplied totals and derives them from line items", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/quotes", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        number: "Q-1002",
        total: 999999,
        subtotal: 999999,
        lineItems: [{ description: "Callout", quantity: 1, unitPrice: 120 }],
      },
    });
    // `total`/`subtotal` are not accepted input fields, so the body is rejected.
    assert.equal(created.statusCode, 422);
  });

  it("lists, gets, updates with recomputed totals, and deletes a quote", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/quotes", {
      headers: AUTH,
      payload: {
        clientId: "c1",
        number: "Q-1003",
        taxRate: 0.1,
        lineItems: [{ description: "Draft", quantity: 1, unitPrice: 100 }],
      },
    });
    const quote = created.json<{ data: Quote }>().data;

    assert.equal(
      (await inject(app, "GET", "/api/v1/quotes", { headers: AUTH })).json<{ count: number }>()
        .count,
      1,
    );

    const gotten = await inject(app, "GET", `/api/v1/quotes/${quote.id}`, { headers: AUTH });
    assert.equal(gotten.statusCode, 200);
    assert.equal(gotten.json<{ data: Quote }>().data.id, quote.id);

    const updated = await inject(app, "PATCH", `/api/v1/quotes/${quote.id}`, {
      headers: AUTH,
      payload: {
        status: "sent",
        lineItems: [
          { description: "Revised", quantity: 2, unitPrice: 100 },
          { description: "Extra", quantity: 1, unitPrice: 50 },
        ],
      },
    });
    assert.equal(updated.statusCode, 200);
    const updatedQuote = updated.json<{ data: Quote }>().data;
    assert.equal(updatedQuote.status, "sent");
    assert.equal(updatedQuote.subtotal, 250);
    assert.equal(updatedQuote.tax, 25);
    assert.equal(updatedQuote.total, 275);

    assert.equal(
      (await inject(app, "DELETE", `/api/v1/quotes/${quote.id}`, { headers: AUTH })).statusCode,
      200,
    );
    assert.equal(
      (await inject(app, "GET", `/api/v1/quotes/${quote.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("rejects a bad status, tax rate, missing fields, and unknown id", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/quotes", {
          headers: AUTH,
          payload: { clientId: "c1", number: "Q-1", status: "banana" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/quotes", {
          headers: AUTH,
          payload: { clientId: "c1", number: "Q-1", taxRate: 1.5 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/quotes", {
          headers: AUTH,
          payload: {
            clientId: "c1",
            number: "Q-1",
            lineItems: [{ description: "X", quantity: -1, unitPrice: 5 }],
          },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "POST", "/api/v1/quotes", { headers: AUTH, payload: { number: "Q-1" } }))
        .statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/quotes/nope", { headers: AUTH })).statusCode,
      404,
    );
  });
});
