import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryErrandStore } from "../src/errands/inMemoryErrandStore.js";
import { JsonErrandStore } from "../src/errands/jsonErrandStore.js";
import type { ErrandStore } from "../src/errands/errand.js";

let dir: string;

function stores(): { name: string; make: () => ErrandStore }[] {
  return [
    { name: "JsonErrandStore", make: () => new JsonErrandStore(path.join(dir, "errands.json")) },
    { name: "InMemoryErrandStore", make: () => new InMemoryErrandStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-errands-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("adds an errand with defaults and trims text", async () => {
      const store = make();
      const errand = await store.add({ title: "  We need milk  " });
      assert.equal(errand.title, "We need milk");
      assert.equal(errand.status, "open");
      assert.equal(errand.quantity, undefined);
      assert.equal(errand.location, undefined);
      assert.equal(errand.completedAt, undefined);
      assert.ok(errand.id.length > 0);
      assert.equal(errand.createdAt, errand.updatedAt);
    });

    it("stores a structured location resolved at the conversation layer", async () => {
      const store = make();
      const errand = await store.add({
        title: "Silicone x2",
        quantity: 2,
        projectId: "p1",
        location: {
          label: "Bunnings Frankston",
          address: "111 Cranbourne Rd, Frankston VIC",
          lat: -38.1579,
          lon: 145.1509,
        },
      });
      assert.equal(errand.quantity, 2);
      assert.equal(errand.location?.label, "Bunnings Frankston");
      assert.equal(errand.location?.lat, -38.1579);
      assert.equal(errand.projectId, "p1");
    });

    it("rejects a blank title, bad quantity, and half-geocoded locations", async () => {
      const store = make();
      await assert.rejects(() => store.add({ title: " " }), /title cannot be empty/);
      await assert.rejects(() => store.add({ title: "X", quantity: 0 }), /positive number/);
      await assert.rejects(
        () => store.add({ title: "X", location: { label: " " } }),
        /label cannot be empty/,
      );
      await assert.rejects(
        () => store.add({ title: "X", location: { label: "Shop", lat: -38 } }),
        /lat and lon must be provided together/,
      );
      await assert.rejects(
        () => store.add({ title: "X", location: { label: "Shop", lat: -95, lon: 145 } }),
        /lat must be a number between -90 and 90/,
      );
      await assert.rejects(
        () => store.add({ title: "X", location: { label: "Shop", lat: -38, lon: 190 } }),
        /lon must be a number between -180 and 180/,
      );
    });

    it("stamps completedAt when done and clears it when reopened", async () => {
      const store = make();
      const errand = await store.add({ title: "Pick up trailer" });
      const done = await store.update(errand.id, { status: "done" });
      assert.equal(done?.status, "done");
      assert.ok((done?.completedAt ?? 0) > 0);
      const stamped = done?.completedAt;
      // Marking done again must not restamp.
      const still = await store.update(errand.id, { status: "done", notes: "same trip" });
      assert.equal(still?.completedAt, stamped);
      const reopened = await store.update(errand.id, { status: "open" });
      assert.equal(reopened?.status, "open");
      assert.equal(reopened?.completedAt, undefined);
    });

    it("clears quantity, location, project, and notes with null", async () => {
      const store = make();
      const errand = await store.add({
        title: "Treat pine",
        quantity: 3,
        notes: "before Friday",
        projectId: "p1",
        location: { label: "Timber yard" },
      });
      const cleared = await store.update(errand.id, {
        quantity: null,
        location: null,
        projectId: null,
        notes: null,
      });
      assert.equal(cleared?.quantity, undefined);
      assert.equal(cleared?.location, undefined);
      assert.equal(cleared?.projectId, undefined);
      assert.equal(cleared?.notes, undefined);
    });

    it("rejects an empty update on an existing errand", async () => {
      const store = make();
      const errand = await store.add({ title: "Milk" });
      await assert.rejects(() => store.update(errand.id, {}), /at least one changed field/);
    });

    it("returns null for unknown ids and removes an errand", async () => {
      const store = make();
      assert.equal(await store.get("nope"), null);
      assert.equal(await store.update("nope", { status: "done" }), null);
      assert.equal(await store.remove("nope"), null);
      const errand = await store.add({ title: "Bolts" });
      assert.equal((await store.remove(errand.id))?.id, errand.id);
      assert.deepEqual(await store.list(), []);
    });
  });
}

describe("JsonErrandStore durability", () => {
  it("reads back the location and completion stamp through a fresh instance", async () => {
    const first = new JsonErrandStore(path.join(dir, "errands.json"));
    const added = await first.add({
      title: "Silicone x2",
      quantity: 2,
      location: { label: "Bunnings Frankston", lat: -38.1579, lon: 145.1509 },
    });
    await first.update(added.id, { status: "done" });
    const reopened = new JsonErrandStore(path.join(dir, "errands.json"));
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, added.id);
    assert.equal(list[0].location?.label, "Bunnings Frankston");
    assert.equal(list[0].location?.lon, 145.1509);
    assert.equal(list[0].status, "done");
    assert.ok((list[0].completedAt ?? 0) > 0);
  });
});
