import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryUpgradeStore } from "../src/upgrades/inMemoryUpgradeStore.js";
import { JsonUpgradeStore } from "../src/upgrades/jsonUpgradeStore.js";
import type { UpgradeStore } from "../src/upgrades/upgrade.js";

let dir: string;

function stores(): { name: string; make: () => UpgradeStore }[] {
  return [
    {
      name: "JsonUpgradeStore",
      make: () => new JsonUpgradeStore(path.join(dir, "upgrades.json")),
    },
    { name: "InMemoryUpgradeStore", make: () => new InMemoryUpgradeStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-upgrades-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("adds a minimal upgrade and trims text", async () => {
      const store = make();
      const entry = await store.add({ buildId: "b1", title: "  New servo  " });
      assert.equal(entry.buildId, "b1");
      assert.equal(entry.title, "New servo");
      assert.equal(entry.reason, undefined);
      assert.equal(entry.parts, undefined);
      assert.equal(entry.occurredAt, undefined);
      assert.ok(entry.id.length > 0);
      assert.ok(entry.createdAt > 0);
    });

    it("records a full upgrade with parts, states, and an occurred time", async () => {
      const store = make();
      const when = Date.UTC(2026, 5, 1, 8, 0, 0);
      const entry = await store.add({
        buildId: "b1",
        title: "Fitted a metal-gear servo",
        reason: "Plastic gears kept stripping on the ledges.",
        beforeState: "Stock plastic-gear steering servo.",
        afterState: "25kg metal-gear servo on a beefed-up mount.",
        outcome: "Held steering authority all day, no slop.",
        parts: ["  25kg servo  ", "servo mount", ""],
        version: "v3",
        occurredAt: when,
      });
      assert.equal(entry.reason, "Plastic gears kept stripping on the ledges.");
      assert.deepEqual(entry.parts, ["25kg servo", "servo mount"]);
      assert.equal(entry.version, "v3");
      assert.equal(entry.occurredAt, when);
    });

    it("rejects a blank buildId or title and a non-numeric occurredAt", async () => {
      const store = make();
      await assert.rejects(
        () => store.add({ buildId: " ", title: "X" }),
        /buildId cannot be empty/,
      );
      await assert.rejects(() => store.add({ buildId: "b1", title: " " }), /title cannot be empty/);
      await assert.rejects(
        // @ts-expect-error occurredAt must be a number
        () => store.add({ buildId: "b1", title: "X", occurredAt: "yesterday" }),
        /occurredAt must be a finite timestamp/,
      );
    });

    it("clears optional fields and parts with null and requires a change", async () => {
      const store = make();
      const entry = await store.add({
        buildId: "b1",
        title: "Swapped ESC",
        reason: "Overheating.",
        parts: ["60A ESC"],
        occurredAt: 1000,
      });
      const cleared = await store.update(entry.id, { reason: null, parts: null, occurredAt: null });
      assert.equal(cleared?.reason, undefined);
      assert.equal(cleared?.parts, undefined);
      assert.equal(cleared?.occurredAt, undefined);
      await assert.rejects(() => store.update(entry.id, {}), /at least one changed field/);
    });

    it("returns null for unknown ids and removes an entry", async () => {
      const store = make();
      assert.equal(await store.get("nope"), null);
      assert.equal(await store.update("nope", { title: "x" }), null);
      assert.equal(await store.remove("nope"), null);
      const entry = await store.add({ buildId: "b1", title: "Repainted the shell" });
      assert.equal((await store.remove(entry.id))?.id, entry.id);
      assert.deepEqual(await store.list(), []);
    });
  });
}

describe("JsonUpgradeStore durability", () => {
  it("reads back a full entry through a fresh instance", async () => {
    const first = new JsonUpgradeStore(path.join(dir, "upgrades.json"));
    const added = await first.add({
      buildId: "b1",
      title: "Regeared the transmission",
      reason: "Wanted more crawl torque.",
      parts: ["27T pinion", "87T spur"],
      version: "v2",
      occurredAt: 4321,
    });
    const reopened = new JsonUpgradeStore(path.join(dir, "upgrades.json"));
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, added.id);
    assert.deepEqual(list[0].parts, ["27T pinion", "87T spur"]);
    assert.equal(list[0].version, "v2");
    assert.equal(list[0].occurredAt, 4321);
  });
});
