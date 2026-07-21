import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getFunctionName } from "convex/server";

import { ConvexBuildLogStore, buildLogFunctions } from "../src/buildLog/convexBuildLogStore.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";

type ConvexStub = {
  query(reference: unknown, args?: Record<string, unknown>): Promise<unknown>;
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
};

function asConvexClient(stub: ConvexStub): ConvexClientLike {
  return stub as ConvexClientLike;
}

function fn(reference: unknown): string {
  return getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
}

function logRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: "log-1",
    _creationTime: 1,
    ownerId: "jarvis-cli",
    buildId: "build-1",
    kind: "milestone",
    title: "First clean crawl",
    createdAt: 1,
    ...overrides,
  };
}

const TOKEN = "test-service-token";

describe("ConvexBuildLogStore", () => {
  it("requires a service token", () => {
    assert.throws(
      () =>
        new ConvexBuildLogStore(
          asConvexClient({ query: async () => null, mutation: async () => null }),
          "",
        ),
      /requires JARVIS_SERVICE_TOKEN/,
    );
  });

  it("lists entries through the authenticated query and maps rows", async () => {
    const store = new ConvexBuildLogStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(args?.serviceToken, TOKEN);
          assert.equal(fn(reference), fn(buildLogFunctions.list));
          return [logRow({ body: "New servo held.", occurredAt: 1000 })];
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    const entries = await store.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "log-1");
    assert.equal(entries[0].kind, "milestone");
    assert.equal(entries[0].occurredAt, 1000);
  });

  it("gets one entry and returns null for a missing one", async () => {
    const store = new ConvexBuildLogStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(fn(reference), fn(buildLogFunctions.get));
          return args?.id === "log-1" ? logRow() : null;
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    assert.equal((await store.get("log-1"))?.id, "log-1");
    assert.equal(await store.get("nope"), null);
  });

  it("creates an entry, forwarding only the provided optional fields", async () => {
    const store = new ConvexBuildLogStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(buildLogFunctions.create));
          assert.deepEqual(args, {
            serviceToken: TOKEN,
            buildId: "build-1",
            title: "First clean crawl",
            kind: "milestone",
          });
          return logRow();
        },
      }),
      TOKEN,
    );
    const created = await store.add({
      buildId: "build-1",
      title: "First clean crawl",
      kind: "milestone",
    });
    assert.equal(created.kind, "milestone");
  });

  it("translates null body and occurredAt into clear flags", async () => {
    let seen: Record<string, unknown> | undefined;
    const store = new ConvexBuildLogStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(buildLogFunctions.update));
          seen = args;
          return logRow({ kind: "note" });
        },
      }),
      TOKEN,
    );
    const updated = await store.update("log-1", { kind: "note", body: null, occurredAt: null });
    assert.equal(updated?.kind, "note");
    assert.deepEqual(seen, {
      serviceToken: TOKEN,
      id: "log-1",
      kind: "note",
      clearBody: true,
      clearOccurredAt: true,
    });
  });

  it("maps an invalid-id error to null on update and remove", async () => {
    const store = new ConvexBuildLogStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation() {
          throw new Error("Invalid document ID provided.");
        },
      }),
      TOKEN,
    );
    assert.equal(await store.update("bad", { kind: "note" }), null);
    assert.equal(await store.remove("bad"), null);
  });

  it("removes an entry and returns the removed row", async () => {
    const store = new ConvexBuildLogStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference) {
          assert.equal(fn(reference), fn(buildLogFunctions.remove));
          return logRow();
        },
      }),
      TOKEN,
    );
    assert.equal((await store.remove("log-1"))?.id, "log-1");
  });
});
