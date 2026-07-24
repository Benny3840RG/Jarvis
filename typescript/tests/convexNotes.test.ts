import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexNoteStore } from "../src/persistence/convexNotes.js";

function noteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "note-1",
    projectId: "project-1",
    title: "Compressor repair notes",
    body: "Replaced the check valve.",
    tags: ["compressor"],
    domain: "workshop",
    sensitivity: "private",
    retention: "long_term",
    sourceRequestId: "request-note-1",
    correlationId: "correlation-note-1",
    source: "tool-action-http",
    revision: 1,
    createdAt: 1_785_000_000_000,
    updatedAt: 1_785_000_000_000,
    ...overrides,
  };
}

describe("ConvexNoteStore", () => {
  it("creates a note through the authenticated owner-scoped mutation", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query() {
        throw new Error("query must not be called by create()");
      },
      async mutation(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return noteRow();
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexNoteStore(client, "owner-service-token");

    const note = await store.create({
      projectId: "project-1",
      title: "Compressor repair notes",
      body: "Replaced the check valve.",
      tags: ["compressor"],
      domain: "workshop",
      sensitivity: "private",
      retention: "long_term",
      idempotencyKey: "execute-note-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:abc",
      sourceRequestId: "request-note-1",
      correlationId: "correlation-note-1",
      source: "tool-action-http",
    });

    assert.deepEqual(calls[0]?.args, {
      serviceToken: "owner-service-token",
      projectId: "project-1",
      title: "Compressor repair notes",
      body: "Replaced the check valve.",
      tags: ["compressor"],
      domain: "workshop",
      sensitivity: "private",
      retention: "long_term",
      idempotencyKey: "execute-note-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:abc",
      sourceRequestId: "request-note-1",
      correlationId: "correlation-note-1",
      source: "tool-action-http",
    });
    assert.equal(note.id, "note-1");
    assert.equal(note.revision, 1);
    assert.equal(note.sensitivity, "private");
  });

  it("retrieves and lists notes through owner-scoped queries", async () => {
    const calls: Array<{ kind: string; args: unknown }> = [];
    const client = {
      async query(_functionRef: unknown, args: unknown) {
        calls.push({ kind: "query", args });
        const queryArgs = args as Record<string, unknown>;
        return "id" in queryArgs ? noteRow() : [noteRow(), noteRow({ _id: "note-2" })];
      },
      async mutation() {
        throw new Error("mutation must not be called");
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexNoteStore(client, "owner-service-token");

    const note = await store.get("project-1", "note-1");
    const notes = await store.list("project-1", 25);

    assert.equal(note?.id, "note-1");
    assert.equal(notes.length, 2);
    assert.deepEqual(
      calls.map(({ args }) => args),
      [
        { serviceToken: "owner-service-token", projectId: "project-1", id: "note-1" },
        { serviceToken: "owner-service-token", projectId: "project-1", limit: 25 },
      ],
    );
  });

  it("requires an authenticated service token", () => {
    const client = {
      async query() {
        return null;
      },
      async mutation() {
        return null;
      },
    } as unknown as ConvexClientLike;

    assert.throws(() => new ConvexNoteStore(client, ""), /require JARVIS_SERVICE_TOKEN/);
  });
});
