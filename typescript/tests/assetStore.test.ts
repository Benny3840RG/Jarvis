import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryAssetStore } from "../src/assets/inMemoryAssetStore.js";
import { JsonAssetStore } from "../src/assets/jsonAssetStore.js";
import type { AssetStore } from "../src/assets/asset.js";

let dir: string;

function stores(): { name: string; make: () => AssetStore }[] {
  return [
    { name: "JsonAssetStore", make: () => new JsonAssetStore(path.join(dir, "assets.json")) },
    { name: "InMemoryAssetStore", make: () => new InMemoryAssetStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-assets-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("adds a minimal asset and trims text", async () => {
      const store = make();
      const asset = await store.add({ name: "  Angle grinder  ", kind: "  power tool  " });
      assert.equal(asset.name, "Angle grinder");
      assert.equal(asset.kind, "power tool");
      assert.equal(asset.serviceIntervalDays, undefined);
      assert.equal(asset.lastServicedAt, undefined);
      assert.ok(asset.id.length > 0);
      assert.ok(asset.createdAt > 0);
      assert.equal(asset.createdAt, asset.updatedAt);
    });

    it("records a serviceable asset with an interval and last-serviced date", async () => {
      const store = make();
      const when = Date.UTC(2026, 0, 1, 0, 0, 0);
      const asset = await store.add({
        name: "Ride-on mower",
        kind: "machine",
        serviceIntervalDays: 90,
        lastServicedAt: when,
        notes: "Blades sharpened last time.",
      });
      assert.equal(asset.serviceIntervalDays, 90);
      assert.equal(asset.lastServicedAt, when);
      assert.match(asset.notes ?? "", /Blades/);
    });

    it("rejects blank name/kind, a non-positive or non-integer interval, and a bad timestamp", async () => {
      const store = make();
      await assert.rejects(() => store.add({ name: " ", kind: "tool" }), /name cannot be empty/);
      await assert.rejects(() => store.add({ name: "X", kind: " " }), /kind cannot be empty/);
      await assert.rejects(
        () => store.add({ name: "X", kind: "tool", serviceIntervalDays: 0 }),
        /positive whole number/,
      );
      await assert.rejects(
        () => store.add({ name: "X", kind: "tool", serviceIntervalDays: 1.5 }),
        /positive whole number/,
      );
      await assert.rejects(
        // @ts-expect-error lastServicedAt must be a number
        () => store.add({ name: "X", kind: "tool", lastServicedAt: "today" }),
        /finite timestamp/,
      );
    });

    it("clears interval, last-serviced, and notes with null and bumps updatedAt", async () => {
      const store = make();
      const asset = await store.add({
        name: "Compressor",
        kind: "machine",
        serviceIntervalDays: 30,
        lastServicedAt: 1000,
        notes: "Drain the tank.",
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const cleared = await store.update(asset.id, {
        serviceIntervalDays: null,
        lastServicedAt: null,
        notes: null,
      });
      assert.equal(cleared?.serviceIntervalDays, undefined);
      assert.equal(cleared?.lastServicedAt, undefined);
      assert.equal(cleared?.notes, undefined);
      assert.ok((cleared?.updatedAt ?? 0) > asset.updatedAt);
      await assert.rejects(() => store.update(asset.id, {}), /at least one changed field/);
    });

    it("returns null for unknown ids and removes an asset", async () => {
      const store = make();
      assert.equal(await store.get("nope"), null);
      assert.equal(await store.update("nope", { name: "x" }), null);
      assert.equal(await store.remove("nope"), null);
      const asset = await store.add({ name: "Welder", kind: "machine" });
      assert.equal((await store.remove(asset.id))?.id, asset.id);
      assert.deepEqual(await store.list(), []);
    });
  });
}

describe("JsonAssetStore durability", () => {
  it("reads back a serviceable asset through a fresh instance", async () => {
    const first = new JsonAssetStore(path.join(dir, "assets.json"));
    const added = await first.add({
      name: "Ute",
      kind: "vehicle",
      serviceIntervalDays: 180,
      lastServicedAt: 5000,
    });
    const reopened = new JsonAssetStore(path.join(dir, "assets.json"));
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, added.id);
    assert.equal(list[0].serviceIntervalDays, 180);
    assert.equal(list[0].lastServicedAt, 5000);
  });
});
