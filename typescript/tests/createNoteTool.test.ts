import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNoteToolDefinition } from "../src/actions/createNoteTool.js";
import type { ToolAction } from "../src/actions/toolActions.js";
import {
  InMemoryToolExecutionReceiptStore,
  ToolExecutionService,
} from "../src/actions/toolExecution.js";
import { createToolExecutionDefinitions } from "../src/actions/toolExecutionFactory.js";
import type { CreateNoteInput, NoteRecord, NoteStore } from "../src/notes/note.js";

const action: ToolAction = {
  actionId: "action-note-1",
  requestId: "request-note-1",
  projectId: "project-1",
  baseRevision: 1,
  state: "approved",
  tool: "notes",
  operation: "create",
  arguments: {
    title: "Compressor repair notes",
    body: "Replaced the check valve and confirmed 120 PSI cut-out.",
    tags: ["compressor", "repair"],
    domain: "workshop",
    sensitivity: "private",
    retention: "long_term",
  },
  rationale: "Store durable workshop knowledge.",
  requiredAuthority: "T1",
  destructive: false,
  idempotencyKey: "proposal-note-1",
  proposedBy: "agent",
  approvedBy: "user",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  approvedAt: "2026-07-24T00:00:00.000Z",
};

class RecordingNoteStore implements NoteStore {
  readonly creates: CreateNoteInput[] = [];

  async create(input: CreateNoteInput): Promise<NoteRecord> {
    this.creates.push(input);
    return {
      id: "note-1",
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      tags: input.tags,
      domain: input.domain,
      sensitivity: input.sensitivity,
      retention: input.retention,
      sourceRequestId: input.sourceRequestId,
      correlationId: input.correlationId,
      source: input.source,
      revision: 1,
      createdAt: 1_785_000_000_000,
      updatedAt: 1_785_000_000_000,
    };
  }

  async get(): Promise<NoteRecord | null> {
    return null;
  }

  async list(): Promise<NoteRecord[]> {
    return [];
  }

  async remove(): Promise<NoteRecord | null> {
    return null;
  }
}

describe("AM-003 create note tool", () => {
  it("creates one durable note and replays the original execution receipt", async () => {
    const store = new RecordingNoteStore();
    const service = new ToolExecutionService([createNoteToolDefinition(store)]);

    const first = await service.execute({
      action,
      authority: "T1",
      idempotencyKey: "execute-note-1",
      correlationId: "correlation-note-1",
      source: "tool-action-http",
    });
    const replay = await service.execute({
      action,
      authority: "T1",
      idempotencyKey: "execute-note-1",
      correlationId: "correlation-note-1",
      source: "tool-action-http",
    });

    assert.equal(first.status, "succeeded");
    assert.deepEqual(replay, first);
    assert.equal(store.creates.length, 1);
    assert.deepEqual(store.creates[0], {
      projectId: "project-1",
      title: "Compressor repair notes",
      body: "Replaced the check valve and confirmed 120 PSI cut-out.",
      tags: ["compressor", "repair"],
      domain: "workshop",
      sensitivity: "private",
      retention: "long_term",
      idempotencyKey: "execute-note-1",
      actionFingerprint: first.actionFingerprint,
      sourceRequestId: "request-note-1",
      correlationId: "correlation-note-1",
      source: "tool-action-http",
    });
  });

  it("replays the original receipt after the execution service restarts", async () => {
    const store = new RecordingNoteStore();
    const receipts = new InMemoryToolExecutionReceiptStore();
    const firstService = new ToolExecutionService([createNoteToolDefinition(store)], receipts);

    const first = await firstService.execute({
      action,
      authority: "T1",
      idempotencyKey: "restart-note",
    });

    const restartedService = new ToolExecutionService([createNoteToolDefinition(store)], receipts);
    const replay = await restartedService.execute({
      action,
      authority: "T1",
      idempotencyKey: "restart-note",
    });

    assert.equal(first.status, "succeeded");
    assert.deepEqual(replay, first);
    assert.equal(store.creates.length, 1);
  });

  it("blocks insufficient authority without mutating the note store", async () => {
    const store = new RecordingNoteStore();
    const service = new ToolExecutionService([createNoteToolDefinition(store)]);

    const result = await service.execute({
      action,
      authority: "T0",
      idempotencyKey: "unauthorized-note",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "not-authorized");
    assert.equal(store.creates.length, 0);
  });

  it("blocks malformed input without mutating the note store", async () => {
    const store = new RecordingNoteStore();
    const service = new ToolExecutionService([createNoteToolDefinition(store)]);

    const result = await service.execute({
      action: { ...action, arguments: { ...action.arguments, title: "   " } },
      authority: "T1",
      idempotencyKey: "invalid-note",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "invalid-arguments");
    assert.equal(store.creates.length, 0);
  });

  it("does not mutate state during dry-run", async () => {
    const store = new RecordingNoteStore();
    const service = new ToolExecutionService([createNoteToolDefinition(store)]);

    const result = await service.execute({
      action,
      authority: "T1",
      idempotencyKey: "dry-run-note",
      dryRun: true,
    });

    assert.equal(result.status, "dry-run");
    assert.equal(store.creates.length, 0);
  });

  it("blocks changed note content under a previously consumed execution key", async () => {
    const store = new RecordingNoteStore();
    const service = new ToolExecutionService([createNoteToolDefinition(store)]);

    await service.execute({ action, authority: "T1", idempotencyKey: "bound-note" });
    const changed = await service.execute({
      action: {
        ...action,
        arguments: { ...action.arguments, body: "Different content after approval." },
      },
      authority: "T1",
      idempotencyKey: "bound-note",
    });

    assert.equal(changed.status, "blocked");
    assert.equal(changed.errorCode, "fingerprint-mismatch");
    assert.equal(store.creates.length, 1);
  });

  it("allowlists only notes:create and blocks every other operation", async () => {
    const store = new RecordingNoteStore();
    const definitions = createToolExecutionDefinitions(store);
    assert.deepEqual(
      definitions.map(({ tool, operation }) => `${tool}:${operation}`),
      ["notes:create"],
    );

    const service = new ToolExecutionService(definitions);
    const blocked = await service.execute({
      action: { ...action, operation: "update" },
      authority: "T1",
      idempotencyKey: "not-allowlisted-note-update",
    });

    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.errorCode, "not-allowlisted");
    assert.equal(store.creates.length, 0);
  });
});
