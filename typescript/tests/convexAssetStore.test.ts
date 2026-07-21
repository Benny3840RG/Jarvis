import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getFunctionName } from "convex/server";

import { ConvexAssetStore, assetFunctions } from "../src/assets/convexAssetStore.js";
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

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: "asset-1",
    _creationTime: 1,
    ownerId: "jarvis-cli",
    name: "Chainsaw",
    kind: "tool",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const TOKEN = "test-service-token";

describe("ConvexAssetStore", () => {
  it("requires a service token", () => {
    assert.throws(
      () =>
        new ConvexAssetStore(
          asConvexClient({ query: async () => null, mutation: async () => null }),
          "",
        ),
      /requires JARVIS_SERVICE_TOKEN/,
    );
  });

  it("lists assets through the authenticated query and maps rows", async () => {
    const store = new ConvexAssetStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(args?.serviceToken, TOKEN);
          assert.equal(fn(reference), fn(assetFunctions.list));
          return [assetRow({ serviceIntervalDays: 90, lastServicedAt: 1000, notes: "Sharpen" })];
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    const assets = await store.list();
    assert.equal(assets.length, 1);
    assert.equal(assets[0].id, "asset-1");
    assert.equal(assets[0].serviceIntervalDays, 90);
    assert.equal(assets[0].lastServicedAt, 1000);
    assert.equal(assets[0].notes, "Sharpen");
  });

  it("gets one asset and returns null for a missing one", async () => {
    const store = new ConvexAssetStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(fn(reference), fn(assetFunctions.get));
          return args?.id === "asset-1" ? assetRow() : null;
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    assert.equal((await store.get("asset-1"))?.id, "asset-1");
    assert.equal(await store.get("nope"), null);
  });

  it("creates an asset, forwarding only the provided optional fields", async () => {
    const store = new ConvexAssetStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(assetFunctions.create));
          assert.deepEqual(args, {
            serviceToken: TOKEN,
            name: "Chainsaw",
            kind: "tool",
            serviceIntervalDays: 90,
          });
          return assetRow({ serviceIntervalDays: 90 });
        },
      }),
      TOKEN,
    );
    const created = await store.add({ name: "Chainsaw", kind: "tool", serviceIntervalDays: 90 });
    assert.equal(created.serviceIntervalDays, 90);
  });

  it("translates null optional fields into clear flags and passes values through", async () => {
    let seen: Record<string, unknown> | undefined;
    const store = new ConvexAssetStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(assetFunctions.update));
          seen = args;
          return assetRow({ updatedAt: 2 });
        },
      }),
      TOKEN,
    );
    const updated = await store.update("asset-1", {
      lastServicedAt: 1500,
      serviceIntervalDays: null,
      notes: null,
    });
    assert.equal(updated?.updatedAt, 2);
    assert.deepEqual(seen, {
      serviceToken: TOKEN,
      id: "asset-1",
      lastServicedAt: 1500,
      clearServiceIntervalDays: true,
      clearNotes: true,
    });
  });

  it("maps an invalid-id error to null on update and remove", async () => {
    const store = new ConvexAssetStore(
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
    assert.equal(await store.update("bad", { name: "x" }), null);
    assert.equal(await store.remove("bad"), null);
  });

  it("removes an asset and returns the removed row", async () => {
    const store = new ConvexAssetStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference) {
          assert.equal(fn(reference), fn(assetFunctions.remove));
          return assetRow();
        },
      }),
      TOKEN,
    );
    assert.equal((await store.remove("asset-1"))?.id, "asset-1");
  });
});
