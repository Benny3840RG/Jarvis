import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { JsonClientStore } from "../src/clients/jsonClientStore.js";

let dir: string;
let store: JsonClientStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-clients-"));
  store = new JsonClientStore(path.join(dir, "clients.json"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonClientStore", () => {
  it("starts empty and persists an added client with a generated id and timestamps", async () => {
    assert.deepEqual(await store.list(), []);
    const client = await store.add({
      name: "  Acme Joinery  ",
      contacts: [{ label: "mobile", value: "0400 000 000" }],
      notes: "Prefers email",
    });
    assert.equal(client.name, "Acme Joinery");
    assert.equal(client.contacts[0].value, "0400 000 000");
    assert.equal(client.notes, "Prefers email");
    assert.ok(client.id.length > 0);
    assert.equal(client.createdAt, client.updatedAt);
  });

  it("reads back through a fresh store instance (durable across processes)", async () => {
    const added = await store.add({ name: "Bob's Cabinets" });
    const reopened = new JsonClientStore(path.join(dir, "clients.json"));
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, added.id);
    assert.equal(list[0].name, "Bob's Cabinets");
    assert.deepEqual(list[0].contacts, []);
  });

  it("rejects a blank name on add and update", async () => {
    await assert.rejects(() => store.add({ name: "   " }), /name cannot be empty/);
    const client = await store.add({ name: "Valid" });
    await assert.rejects(() => store.update(client.id, { name: " " }), /name cannot be empty/);
  });

  it("updates fields, clears notes with null, and advances updatedAt", async () => {
    const client = await store.add({ name: "Old", notes: "keep" });
    const updated = await store.update(client.id, { name: "New", notes: null });
    assert.ok(updated);
    assert.equal(updated?.name, "New");
    assert.equal(updated?.notes, undefined);
    assert.ok((updated?.updatedAt ?? 0) >= client.createdAt);
    // Unchanged fields survive a partial update.
    const contactsOnly = await store.update(client.id, { contacts: [{ value: "x@y.z" }] });
    assert.equal(contactsOnly?.name, "New");
    assert.equal(contactsOnly?.contacts[0].value, "x@y.z");
  });

  it("requires at least one field to update", async () => {
    const client = await store.add({ name: "Someone" });
    await assert.rejects(() => store.update(client.id, {}), /requires a name, contacts, or notes/);
  });

  it("returns null for get/update/remove of an unknown id", async () => {
    assert.equal(await store.get("nope"), null);
    assert.equal(await store.update("nope", { name: "X" }), null);
    assert.equal(await store.remove("nope"), null);
  });

  it("removes a client and leaves the rest intact", async () => {
    const a = await store.add({ name: "A" });
    const b = await store.add({ name: "B" });
    const removed = await store.remove(a.id);
    assert.equal(removed?.id, a.id);
    const list = await store.list();
    assert.deepEqual(
      list.map((client) => client.id),
      [b.id],
    );
  });

  it("serialises concurrent adds without losing writes", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => store.add({ name: `Client ${index}` })),
    );
    assert.equal((await store.list()).length, 8);
  });
});
