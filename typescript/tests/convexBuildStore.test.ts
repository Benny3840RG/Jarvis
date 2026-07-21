import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getFunctionName } from "convex/server";

import { ConvexBuildStore, buildFunctions } from "../src/builds/convexBuildStore.js";
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

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: "build-1",
    _creationTime: 1,
    ownerId: "jarvis-cli",
    name: "Rock crawler",
    kind: "RC crawler",
    status: "planning",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const TOKEN = "test-service-token";

describe("ConvexBuildStore", () => {
  it("requires a service token", () => {
    assert.throws(
      () =>
        new ConvexBuildStore(
          asConvexClient({ query: async () => null, mutation: async () => null }),
          "",
        ),
      /requires JARVIS_SERVICE_TOKEN/,
    );
  });

  it("lists builds through the authenticated query and maps rows", async () => {
    const store = new ConvexBuildStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(args?.serviceToken, TOKEN);
          assert.equal(fn(reference), fn(buildFunctions.list));
          return [buildRow({ nickname: "The Goat", description: "A crawler" })];
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    const builds = await store.list();
    assert.equal(builds.length, 1);
    assert.equal(builds[0].id, "build-1");
    assert.equal(builds[0].name, "Rock crawler");
    assert.equal(builds[0].nickname, "The Goat");
  });

  it("gets one build and returns null for a missing one", async () => {
    const store = new ConvexBuildStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(fn(reference), fn(buildFunctions.get));
          return args?.id === "build-1" ? buildRow() : null;
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    assert.equal((await store.get("build-1"))?.id, "build-1");
    assert.equal(await store.get("nope"), null);
  });

  it("creates a build, forwarding only the provided optional fields", async () => {
    const store = new ConvexBuildStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(buildFunctions.create));
          assert.deepEqual(args, {
            serviceToken: TOKEN,
            name: "Rock crawler",
            kind: "RC crawler",
            nickname: "The Goat",
          });
          return buildRow({ nickname: "The Goat" });
        },
      }),
      TOKEN,
    );
    const created = await store.add({
      name: "Rock crawler",
      kind: "RC crawler",
      nickname: "The Goat",
    });
    assert.equal(created.nickname, "The Goat");
  });

  it("translates a nullable update field into a clear flag and passes values through", async () => {
    let seen: Record<string, unknown> | undefined;
    const store = new ConvexBuildStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(buildFunctions.update));
          seen = args;
          return buildRow({ status: "active" });
        },
      }),
      TOKEN,
    );
    const updated = await store.update("build-1", { status: "active", nickname: null });
    assert.equal(updated?.status, "active");
    assert.deepEqual(seen, {
      serviceToken: TOKEN,
      id: "build-1",
      status: "active",
      clearNickname: true,
    });
  });

  it("maps an invalid-id error to null on update and remove", async () => {
    const store = new ConvexBuildStore(
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
    assert.equal(await store.update("bad", { status: "active" }), null);
    assert.equal(await store.remove("bad"), null);
  });

  it("removes a build and returns the removed row", async () => {
    const store = new ConvexBuildStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference) {
          assert.equal(fn(reference), fn(buildFunctions.remove));
          return buildRow();
        },
      }),
      TOKEN,
    );
    assert.equal((await store.remove("build-1"))?.id, "build-1");
  });
});
