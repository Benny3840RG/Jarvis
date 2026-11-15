import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  completeErrandToolDefinition,
  createErrandArgumentsSchema,
  createErrandToolDefinition,
  errandIdForToolAction,
  removeErrandToolDefinition,
} from "../src/actions/errandTools.js";
import { createToolExecutionDefinitions } from "../src/actions/toolExecutionFactory.js";
import {
  deriveToolExecutionIdempotencyKey,
  ToolExecutionService,
} from "../src/actions/toolExecution.js";
import type { ToolAction } from "../src/actions/toolActions.js";
import type { ErrandInput } from "../src/errands/errand.js";
import { InMemoryErrandStore } from "../src/errands/inMemoryErrandStore.js";
import { JsonErrandStore } from "../src/errands/jsonErrandStore.js";
import type { NoteStore } from "../src/notes/note.js";

function approvedAction(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "voice-safe-write:v1:errand-1",
    requestId: "voice-safe-write:v1:errand-1",
    projectId: "convex-project-1",
    baseRevision: 1,
    tool: "errands",
    operation: "create",
    arguments: { title: "Silicone for the deck" },
    rationale: "Voice safe write client.capture-errand",
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: "voice-safe-write:v1:errand-1",
    proposedBy: "user",
    state: "approved",
    approvedBy: "user",
    approvedAt: new Date().toISOString(),
    isApprovalExpired: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as ToolAction;
}

function execute(service: ToolExecutionService, action: ToolAction) {
  return service.execute({
    action,
    authority: "T3",
    idempotencyKey: deriveToolExecutionIdempotencyKey(action.actionId, "live"),
    approvalId: action.actionId,
    policyVersion: "totality-policy:v1",
    correlationId: action.requestId,
    source: "tool-action-http-controller",
  });
}

describe("errands:create executor", () => {
  it("creates one open errand from an approved action and never a second on retry", async () => {
    const store = new InMemoryErrandStore();
    const service = new ToolExecutionService([createErrandToolDefinition(store)]);
    const action = approvedAction();
    const first = await execute(service, action);
    assert.equal(first.status, "succeeded");
    const second = await execute(service, action);
    assert.equal(second.status, "succeeded");
    const errands = await store.list();
    assert.equal(errands.length, 1);
    assert.equal(errands[0]?.title, "Silicone for the deck");
    assert.equal(errands[0]?.status, "open");
    // The ToolAction's governing project is never copied onto the errand.
    assert.equal(errands[0]?.projectId, undefined);
  });

  it("finds the earlier row when a write landed but its receipt did not", async () => {
    const store = new InMemoryErrandStore();
    const definition = createErrandToolDefinition(store);
    const action = approvedAction();
    const context = {
      action,
      idempotencyKey: deriveToolExecutionIdempotencyKey(action.actionId, "live"),
      actionFingerprint: "fingerprint",
      correlationId: action.requestId,
      source: "test",
    } as Parameters<typeof definition.execute>[2];
    const signal = new AbortController().signal;
    const first = await definition.execute(action.arguments, signal, context);
    const replay = await definition.execute(action.arguments, signal, context);
    assert.deepEqual(replay, first);
    assert.equal((await store.list()).length, 1);
  });

  it("does nothing without an approval", async () => {
    let writes = 0;
    const store = new InMemoryErrandStore();
    const counting = Object.assign(Object.create(store) as InMemoryErrandStore, {
      addOnce: (id: string, input: ErrandInput) => {
        writes += 1;
        return store.addOnce(id, input);
      },
    });
    const service = new ToolExecutionService([createErrandToolDefinition(counting)]);
    const receipt = await execute(service, approvedAction({ state: "proposed" }));
    assert.notEqual(receipt.status, "succeeded");
    assert.equal(writes, 0);
    assert.equal((await store.list()).length, 0);
  });

  it("accepts only a bounded title, quantity and note", () => {
    for (const value of [
      { title: "Bar oil" },
      { title: "Bar oil", quantity: 2 },
      { title: "Bar oil", notes: "the 20 L drum" },
    ])
      assert.equal(
        createErrandArgumentsSchema.safeParse(value).success,
        true,
        JSON.stringify(value),
      );
    for (const value of [
      {},
      { title: " " },
      { title: "x".repeat(201) },
      { title: "Bar oil", quantity: 0 },
      { title: "Bar oil", quantity: 1.5 },
      { title: "Bar oil", projectId: "p" },
      { title: "Bar oil", location: { label: "Bunnings" } },
      { title: "Bar oil", status: "done" },
      { title: "Bar oil", category: "work" },
    ])
      assert.equal(
        createErrandArgumentsSchema.safeParse(value).success,
        false,
        JSON.stringify(value),
      );
  });

  it("derives a stable UUID-shaped id per action and execution key", () => {
    const base = { projectId: "p", actionId: "a", idempotencyKey: "k" };
    const id = errandIdForToolAction(base);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(errandIdForToolAction(base), id);
    assert.notEqual(errandIdForToolAction({ ...base, actionId: "b" }), id);
    assert.notEqual(errandIdForToolAction({ ...base, idempotencyKey: "j" }), id);
    assert.notEqual(errandIdForToolAction({ ...base, projectId: "q" }), id);
  });

  it("writes the same JSON errand file the HTTP routes read", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jarvis-errand-tool-"));
    try {
      const file = path.join(dir, "jarvis-errands.json");
      const service = new ToolExecutionService([
        createErrandToolDefinition(new JsonErrandStore(file)),
      ]);
      assert.equal((await execute(service, approvedAction())).status, "succeeded");
      const httpSide = await new JsonErrandStore(file).list();
      assert.equal(httpSide.length, 1);
      assert.equal(httpSide[0]?.title, "Silicone for the deck");
      const document = JSON.parse(await readFile(file, "utf8"));
      assert.equal(document.errands.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is registered only when an errand store is supplied", () => {
    const notes = {} as NoteStore;
    const keys = (definitions: ReturnType<typeof createToolExecutionDefinitions>) =>
      definitions.map((definition) => `${definition.tool}:${definition.operation}`);
    assert.equal(keys(createToolExecutionDefinitions(notes)).includes("errands:create"), false);
    const withErrands = createToolExecutionDefinitions(
      notes,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new InMemoryErrandStore(),
    );
    assert.equal(keys(withErrands).includes("errands:create"), true);
    assert.equal(keys(withErrands).includes("errands:complete"), true);
    assert.equal(keys(withErrands).includes("errands:remove"), true);
  });
});

describe("errands:complete executor", () => {
  it("marks one open errand done, harmlessly again on retry, and refuses a missing errand", async () => {
    const store = new InMemoryErrandStore();
    const milk = await store.add({ title: "Milk" });
    const bread = await store.add({ title: "Bread" });
    const service = new ToolExecutionService([completeErrandToolDefinition(store)]);
    const action = approvedAction({
      operation: "complete",
      arguments: { errandId: milk.id },
    });
    assert.equal((await execute(service, action)).status, "succeeded");
    assert.equal((await store.get(milk.id))?.status, "done");
    assert.equal((await store.get(bread.id))?.status, "open");

    // Already done: returned unchanged, even through a fresh execution key.
    const definition = completeErrandToolDefinition(store);
    const done = await definition.execute(
      { errandId: milk.id },
      new AbortController().signal,
      {} as Parameters<typeof definition.execute>[2],
    );
    assert.equal((done as { status: string }).status, "done");

    const missing = approvedAction({
      actionId: "voice-safe-write:v1:missing",
      requestId: "voice-safe-write:v1:missing",
      operation: "complete",
      arguments: { errandId: "nope" },
    });
    assert.notEqual((await execute(service, missing)).status, "succeeded");
    for (const value of [{}, { errandId: "" }, { errandId: "x", title: "Milk" }]) {
      assert.equal(definition.schema.safeParse(value).success, false, JSON.stringify(value));
    }
  });
});

describe("errands:remove executor", () => {
  it("removes exactly one errand, and a retry after it is gone is harmless", async () => {
    const store = new InMemoryErrandStore();
    const milk = await store.add({ title: "Milk" });
    const bread = await store.add({ title: "Bread" });
    const service = new ToolExecutionService([removeErrandToolDefinition(store)]);
    const action = approvedAction({ operation: "remove", arguments: { errandId: milk.id } });
    const receipt = await execute(service, action);
    assert.equal(receipt.status, "succeeded");
    assert.equal(await store.get(milk.id), null);
    assert.deepEqual(
      (await store.list()).map((errand) => errand.id),
      [bread.id],
    );

    // Already gone (a crash before the receipt, or removed on the HUD meanwhile).
    const definition = removeErrandToolDefinition(store);
    const again = await definition.execute(
      { errandId: milk.id },
      new AbortController().signal,
      {} as Parameters<typeof definition.execute>[2],
    );
    assert.deepEqual(again, { errandId: milk.id, removed: false });
    assert.equal((await store.list()).length, 1, "a retry never removes anything else");

    for (const value of [{}, { errandId: "" }, { errandId: "x", title: "Milk" }]) {
      assert.equal(definition.schema.safeParse(value).success, false, JSON.stringify(value));
    }
  });
});
