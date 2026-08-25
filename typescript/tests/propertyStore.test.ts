import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { JsonPropertyStore } from "../src/properties/jsonPropertyStore.js";

let dir: string;
let store: JsonPropertyStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-properties-"));
  store = new JsonPropertyStore(path.join(dir, "properties.json"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonPropertyStore", () => {
  it("starts empty and persists a property with generated id and timestamps", async () => {
    assert.deepEqual(await store.list(), []);
    const property = await store.add({
      clientId: "client-1",
      address: "  12 Gum Street, Preston VIC 3072  ",
      hazards: [" dog on site ", "dog on site", "low branch"],
      accessNotes: "Gate code 1234",
      serviceNotes: "Council green-waste bin beside driveway",
    });
    assert.equal(property.clientId, "client-1");
    assert.equal(property.address, "12 Gum Street, Preston VIC 3072");
    assert.deepEqual(property.hazards, ["dog on site", "low branch"]);
    assert.equal(property.accessNotes, "Gate code 1234");
    assert.ok(property.id.length > 0);
    assert.equal(property.createdAt, property.updatedAt);
  });

  it("reads back through a fresh store instance and filters by client", async () => {
    const first = await store.add({ clientId: "client-1", address: "1 First Street" });
    await store.add({ clientId: "client-2", address: "2 Second Street" });

    const reopened = new JsonPropertyStore(path.join(dir, "properties.json"));
    assert.equal((await reopened.list()).length, 2);
    assert.deepEqual(
      (await reopened.list({ clientId: "client-1" })).map((property) => property.id),
      [first.id],
    );
  });

  it("rejects blank required fields", async () => {
    await assert.rejects(
      () => store.add({ clientId: " ", address: "Somewhere" }),
      /clientId cannot be empty/,
    );
    await assert.rejects(
      () => store.add({ clientId: "client-1", address: " " }),
      /address cannot be empty/,
    );
  });

  it("updates fields, clears optional notes, and preserves hazards", async () => {
    const property = await store.add({
      clientId: "client-1",
      address: "Old address",
      hazards: ["steps"],
      accessNotes: "Old access",
      serviceNotes: "Old service",
    });

    const updated = await store.update(property.id, {
      address: "New address",
      accessNotes: null,
    });
    assert.ok(updated);
    assert.equal(updated?.address, "New address");
    assert.equal(updated?.accessNotes, undefined);
    assert.equal(updated?.serviceNotes, "Old service");
    assert.deepEqual(updated?.hazards, ["steps"]);
    assert.ok((updated?.updatedAt ?? 0) >= property.createdAt);

    const hazardsOnly = await store.update(property.id, { hazards: ["dogs", "dogs", "slopes"] });
    assert.deepEqual(hazardsOnly?.hazards, ["dogs", "slopes"]);
  });

  it("requires at least one field to update", async () => {
    const property = await store.add({ clientId: "client-1", address: "Somewhere" });
    await assert.rejects(() => store.update(property.id, {}), /requires at least one/);
  });

  it("returns null for get, update, and remove of an unknown id", async () => {
    assert.equal(await store.get("nope"), null);
    assert.equal(await store.update("nope", { address: "X" }), null);
    assert.equal(await store.remove("nope"), null);
  });

  it("removes a property and leaves other client properties intact", async () => {
    const a = await store.add({ clientId: "client-1", address: "A" });
    const b = await store.add({ clientId: "client-1", address: "B" });
    const removed = await store.remove(a.id);
    assert.equal(removed?.id, a.id);
    assert.deepEqual(
      (await store.list()).map((property) => property.id),
      [b.id],
    );
  });

  it("serialises concurrent adds without losing writes", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        store.add({ clientId: "client-1", address: `Property ${index}` }),
      ),
    );
    assert.equal((await store.list()).length, 8);
  });
});
