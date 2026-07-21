import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getFunctionName } from "convex/server";

import {
  ConvexPreferenceStore,
  preferenceFunctions,
} from "../src/preferences/convexPreferenceStore.js";
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

function preferenceRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: "pref-1",
    _creationTime: 1,
    ownerId: "jarvis-cli",
    key: "paint-brand",
    value: "Dulux",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const TOKEN = "test-service-token";

describe("ConvexPreferenceStore", () => {
  it("requires a service token", () => {
    assert.throws(
      () =>
        new ConvexPreferenceStore(
          asConvexClient({ query: async () => null, mutation: async () => null }),
          "",
        ),
      /requires JARVIS_SERVICE_TOKEN/,
    );
  });

  it("lists preferences through the authenticated query and maps rows", async () => {
    const store = new ConvexPreferenceStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(args?.serviceToken, TOKEN);
          assert.equal(fn(reference), fn(preferenceFunctions.list));
          return [preferenceRow({ category: "paint" })];
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    const prefs = await store.list();
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0].id, "pref-1");
    assert.equal(prefs[0].key, "paint-brand");
    assert.equal(prefs[0].category, "paint");
  });

  it("gets one preference and returns null for a missing one", async () => {
    const store = new ConvexPreferenceStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(fn(reference), fn(preferenceFunctions.get));
          return args?.id === "pref-1" ? preferenceRow() : null;
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    assert.equal((await store.get("pref-1"))?.id, "pref-1");
    assert.equal(await store.get("nope"), null);
  });

  it("creates a preference, forwarding only the provided optional fields", async () => {
    const store = new ConvexPreferenceStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(preferenceFunctions.create));
          assert.deepEqual(args, {
            serviceToken: TOKEN,
            key: "paint-brand",
            value: "Dulux",
            category: "paint",
          });
          return preferenceRow({ category: "paint" });
        },
      }),
      TOKEN,
    );
    const created = await store.add({ key: "paint-brand", value: "Dulux", category: "paint" });
    assert.equal(created.category, "paint");
  });

  it("translates a null category into the clear flag and passes values through", async () => {
    let seen: Record<string, unknown> | undefined;
    const store = new ConvexPreferenceStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(preferenceFunctions.update));
          seen = args;
          return preferenceRow({ value: "Resene", updatedAt: 2 });
        },
      }),
      TOKEN,
    );
    const updated = await store.update("pref-1", { value: "Resene", category: null });
    assert.equal(updated?.updatedAt, 2);
    assert.deepEqual(seen, {
      serviceToken: TOKEN,
      id: "pref-1",
      value: "Resene",
      clearCategory: true,
    });
  });

  it("maps an invalid-id error to null on update and remove", async () => {
    const store = new ConvexPreferenceStore(
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
    assert.equal(await store.update("bad", { value: "x" }), null);
    assert.equal(await store.remove("bad"), null);
  });

  it("removes a preference and returns the removed row", async () => {
    const store = new ConvexPreferenceStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference) {
          assert.equal(fn(reference), fn(preferenceFunctions.remove));
          return preferenceRow();
        },
      }),
      TOKEN,
    );
    assert.equal((await store.remove("pref-1"))?.id, "pref-1");
  });
});
