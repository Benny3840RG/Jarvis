import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getFunctionName } from "convex/server";

import { ConvexUpgradeStore, upgradeFunctions } from "../src/upgrades/convexUpgradeStore.js";
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

function upgradeRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: "upg-1",
    _creationTime: 1,
    ownerId: "jarvis-cli",
    buildId: "build-1",
    title: "New brushless motor",
    createdAt: 1,
    ...overrides,
  };
}

const TOKEN = "test-service-token";

describe("ConvexUpgradeStore", () => {
  it("requires a service token", () => {
    assert.throws(
      () =>
        new ConvexUpgradeStore(
          asConvexClient({ query: async () => null, mutation: async () => null }),
          "",
        ),
      /requires JARVIS_SERVICE_TOKEN/,
    );
  });

  it("lists entries through the authenticated query and maps rows", async () => {
    const store = new ConvexUpgradeStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(args?.serviceToken, TOKEN);
          assert.equal(fn(reference), fn(upgradeFunctions.list));
          return [
            upgradeRow({
              reason: "More torque",
              parts: ["motor", "esc"],
              occurredAt: 1000,
            }),
          ];
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    const entries = await store.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "upg-1");
    assert.equal(entries[0].reason, "More torque");
    assert.deepEqual(entries[0].parts, ["motor", "esc"]);
    assert.equal(entries[0].occurredAt, 1000);
  });

  it("gets one entry and returns null for a missing one", async () => {
    const store = new ConvexUpgradeStore(
      asConvexClient({
        async query(reference, args) {
          assert.equal(fn(reference), fn(upgradeFunctions.get));
          return args?.id === "upg-1" ? upgradeRow() : null;
        },
        async mutation() {
          throw new Error("no mutation expected");
        },
      }),
      TOKEN,
    );
    assert.equal((await store.get("upg-1"))?.id, "upg-1");
    assert.equal(await store.get("nope"), null);
  });

  it("creates an entry, forwarding only the provided optional fields", async () => {
    const store = new ConvexUpgradeStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(upgradeFunctions.create));
          assert.deepEqual(args, {
            serviceToken: TOKEN,
            buildId: "build-1",
            title: "New brushless motor",
            reason: "More torque",
            parts: ["motor", "esc"],
          });
          return upgradeRow({ reason: "More torque", parts: ["motor", "esc"] });
        },
      }),
      TOKEN,
    );
    const created = await store.add({
      buildId: "build-1",
      title: "New brushless motor",
      reason: "More torque",
      parts: ["motor", "esc"],
    });
    assert.deepEqual(created.parts, ["motor", "esc"]);
  });

  it("translates null scalar fields into clear flags", async () => {
    let seen: Record<string, unknown> | undefined;
    const store = new ConvexUpgradeStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference, args) {
          assert.equal(fn(reference), fn(upgradeFunctions.update));
          seen = args;
          return upgradeRow({ title: "Reverted" });
        },
      }),
      TOKEN,
    );
    const updated = await store.update("upg-1", {
      title: "Reverted",
      reason: null,
      beforeState: null,
      afterState: null,
      outcome: null,
      version: null,
      occurredAt: null,
    });
    assert.equal(updated?.title, "Reverted");
    assert.deepEqual(seen, {
      serviceToken: TOKEN,
      id: "upg-1",
      title: "Reverted",
      clearReason: true,
      clearBeforeState: true,
      clearAfterState: true,
      clearOutcome: true,
      clearVersion: true,
      clearOccurredAt: true,
    });
  });

  it("passes a parts array through and translates a null parts into clearParts", async () => {
    let seen: Record<string, unknown> | undefined;
    const store = new ConvexUpgradeStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(_reference, args) {
          seen = args;
          return upgradeRow();
        },
      }),
      TOKEN,
    );
    await store.update("upg-1", { parts: ["prop", "battery"] });
    assert.deepEqual(seen, {
      serviceToken: TOKEN,
      id: "upg-1",
      parts: ["prop", "battery"],
    });

    await store.update("upg-1", { parts: null });
    assert.deepEqual(seen, {
      serviceToken: TOKEN,
      id: "upg-1",
      clearParts: true,
    });
  });

  it("maps an invalid-id error to null on update and remove", async () => {
    const store = new ConvexUpgradeStore(
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
    assert.equal(await store.update("bad", { title: "x" }), null);
    assert.equal(await store.remove("bad"), null);
  });

  it("removes an entry and returns the removed row", async () => {
    const store = new ConvexUpgradeStore(
      asConvexClient({
        async query() {
          throw new Error("no query expected");
        },
        async mutation(reference) {
          assert.equal(fn(reference), fn(upgradeFunctions.remove));
          return upgradeRow();
        },
      }),
      TOKEN,
    );
    assert.equal((await store.remove("upg-1"))?.id, "upg-1");
  });
});
