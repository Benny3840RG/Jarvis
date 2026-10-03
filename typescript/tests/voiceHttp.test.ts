import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "voice-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function persistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("voice HTTP tests must not touch persistence");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: () => Promise.resolve([]),
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: () => Promise.resolve([]),
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

const openApps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function makeApp(): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: persistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
  });
  openApps.push(app);
  return app;
}

async function openSession(app: NestFastifyApplication, profile: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/voice/sessions",
    headers: AUTH,
    payload: { profile },
  });
  assert.equal(response.statusCode, 201);
  return response.json().sessionId as string;
}

function utter(app: NestFastifyApplication, sessionId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/voice/sessions/${sessionId}/utterances`,
    headers: AUTH,
    payload,
  });
}

describe("voice HTTP boundary", () => {
  it("requires authentication on every voice route", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/voice/catalog" });
    assert.equal(response.statusCode, 401);
  });

  it("lists the bounded command catalogue", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/voice/catalog",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual([...body.profiles].sort(), ["client", "crawler", "trailer", "workshop"]);
    assert.ok(body.commands.length >= 20 && body.commands.length <= 40);
    assert.ok(body.commands.some((c: { id: string }) => c.id === "trailer.winch-up"));
  });

  it("opens a session and answers a read-only query directly", async () => {
    const app = await makeApp();
    const sessionId = await openSession(app, "client");
    const response = await utter(app, sessionId, {
      transcript: "any unpaid invoices",
      isFinal: true,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().dispatch.decision, "answer-query");
  });

  it("only proposes a governed send — a spoken confirm never approves it", async () => {
    const app = await makeApp();
    const sessionId = await openSession(app, "client");
    const armed = await utter(app, sessionId, { transcript: "send the quote", isFinal: true });
    assert.equal(armed.json().dispatch.decision, "awaiting-confirmation");
    assert.ok(armed.json().pending, "a pending confirmation is held server-side");

    const confirmed = await utter(app, sessionId, { transcript: "confirm", isFinal: true });
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    assert.equal(dispatch.command.proposes.operation, "quotes:send");
    assert.equal(confirmed.json().pending, null, "confirmation consumed");
  });

  it("fails closed when a confirmed actuation has no hardware", async () => {
    const app = await makeApp();
    const sessionId = await openSession(app, "trailer");
    await utter(app, sessionId, { transcript: "winch up", isFinal: true });
    const confirmed = await utter(app, sessionId, { transcript: "confirm", isFinal: true });
    assert.equal(confirmed.json().dispatch.decision, "actuation-unavailable");
  });

  it("ignores an interim transcript over HTTP", async () => {
    const app = await makeApp();
    const sessionId = await openSession(app, "trailer");
    const response = await utter(app, sessionId, { transcript: "winch up", isFinal: false });
    assert.equal(response.json().dispatch.decision, "ignored-interim");
  });

  it("invalidates a pending confirmation when the profile switches", async () => {
    const app = await makeApp();
    const sessionId = await openSession(app, "trailer");
    await utter(app, sessionId, { transcript: "winch up", isFinal: true });
    const switched = await app.inject({
      method: "POST",
      url: `/api/v1/voice/sessions/${sessionId}/profile`,
      headers: AUTH,
      payload: { profile: "workshop" },
    });
    assert.equal(switched.statusCode, 200);
    assert.equal(switched.json().profile, "workshop");
    const confirm = await utter(app, sessionId, { transcript: "confirm", isFinal: true });
    assert.equal(confirm.json().dispatch.decision, "confirmation-not-pending");
  });

  it("returns 404 for an unknown or ended session", async () => {
    const app = await makeApp();
    const sessionId = await openSession(app, "client");
    const ended = await app.inject({
      method: "DELETE",
      url: `/api/v1/voice/sessions/${sessionId}`,
      headers: AUTH,
    });
    assert.equal(ended.statusCode, 200);
    const afterEnd = await utter(app, sessionId, {
      transcript: "any unpaid invoices",
      isFinal: true,
    });
    assert.equal(afterEnd.statusCode, 404);
  });

  it("rejects an invalid profile and a malformed utterance with 422", async () => {
    const app = await makeApp();
    const badProfile = await app.inject({
      method: "POST",
      url: "/api/v1/voice/sessions",
      headers: AUTH,
      payload: { profile: "spaceship" },
    });
    assert.equal(badProfile.statusCode, 422);

    const sessionId = await openSession(app, "client");
    const badUtterance = await utter(app, sessionId, { transcript: 42, isFinal: "yes" });
    assert.equal(badUtterance.statusCode, 422);
  });
});
