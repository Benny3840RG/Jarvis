import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import { InMemoryNoteStore } from "../src/notes/inMemoryNoteStore.js";
import type { CreateNoteInput, NoteRecord } from "../src/notes/note.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "note-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in note HTTP tests");
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

function noteInput(overrides: Partial<CreateNoteInput> = {}): CreateNoteInput {
  return {
    projectId: "project-1",
    title: "Torque spec",
    body: "18mm hub nuts: 120Nm.",
    tags: ["crawler"],
    domain: "workshop",
    sensitivity: "internal",
    retention: "standard",
    idempotencyKey: "seed-key-1",
    actionFingerprint: "seed-fingerprint-1",
    sourceRequestId: "seed-request-1",
    correlationId: "seed-correlation-1",
    source: "test-seed",
    ...overrides,
  };
}

const openApps: NestFastifyApplication[] = [];

async function makeApp(store: InMemoryNoteStore): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: unusedPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    noteStore: store,
  });
  openApps.push(app);
  return app;
}

function inject(
  app: NestFastifyApplication,
  method: InjectMethod,
  url: string,
  options: { headers?: Record<string, string> } = {},
) {
  return app.inject({ method, url, headers: { ...(options.headers ?? {}) } });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("note HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp(new InMemoryNoteStore());
    assert.equal((await inject(app, "GET", "/api/v1/projects/project-1/notes")).statusCode, 401);
  });

  it("lists, gets, and removes notes scoped to their project", async () => {
    const store = new InMemoryNoteStore();
    const inProject = await store.create(noteInput());
    await store.create(
      noteInput({ projectId: "other-project", idempotencyKey: "seed-key-2", title: "Elsewhere" }),
    );
    const app = await makeApp(store);

    const listed = await inject(app, "GET", "/api/v1/projects/project-1/notes", {
      headers: AUTH,
    });
    assert.equal(listed.statusCode, 200);
    const listedBody = listed.json<{ data: NoteRecord[]; count: number }>();
    assert.equal(listedBody.count, 1);
    assert.equal(listedBody.data[0]?.id, inProject.id);

    const gotten = await inject(app, "GET", `/api/v1/projects/project-1/notes/${inProject.id}`, {
      headers: AUTH,
    });
    assert.equal(gotten.statusCode, 200);
    assert.equal(gotten.json<{ data: NoteRecord }>().data.title, "Torque spec");

    const removed = await inject(
      app,
      "DELETE",
      `/api/v1/projects/project-1/notes/${inProject.id}`,
      { headers: AUTH },
    );
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json<{ data: NoteRecord }>().data.id, inProject.id);

    assert.equal(
      (
        await inject(app, "GET", `/api/v1/projects/project-1/notes/${inProject.id}`, {
          headers: AUTH,
        })
      ).statusCode,
      404,
    );
  });

  it("does not leak a note across a mismatched projectId in the URL", async () => {
    const store = new InMemoryNoteStore();
    const note = await store.create(noteInput());
    const app = await makeApp(store);

    assert.equal(
      (
        await inject(app, "GET", `/api/v1/projects/other-project/notes/${note.id}`, {
          headers: AUTH,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await inject(app, "DELETE", `/api/v1/projects/other-project/notes/${note.id}`, {
          headers: AUTH,
        })
      ).statusCode,
      404,
    );
    // Confirm the mismatched-project delete attempt above did not remove it.
    assert.equal(
      (await inject(app, "GET", `/api/v1/projects/project-1/notes/${note.id}`, { headers: AUTH }))
        .statusCode,
      200,
    );
  });

  it("returns 404 for an unknown note id", async () => {
    const app = await makeApp(new InMemoryNoteStore());
    assert.equal(
      (await inject(app, "GET", "/api/v1/projects/project-1/notes/nope", { headers: AUTH }))
        .statusCode,
      404,
    );
  });
});
