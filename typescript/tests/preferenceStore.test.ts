import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryPreferenceStore } from "../src/preferences/inMemoryPreferenceStore.js";
import { JsonPreferenceStore } from "../src/preferences/jsonPreferenceStore.js";
import type { PreferenceStore } from "../src/preferences/preference.js";

let dir: string;

function stores(): { name: string; make: () => PreferenceStore }[] {
  return [
    {
      name: "JsonPreferenceStore",
      make: () => new JsonPreferenceStore(path.join(dir, "preferences.json")),
    },
    { name: "InMemoryPreferenceStore", make: () => new InMemoryPreferenceStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-preferences-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("adds a minimal preference and trims text", async () => {
      const store = make();
      const pref = await store.add({ key: "  paint brand  ", value: "  Dulux  " });
      assert.equal(pref.key, "paint brand");
      assert.equal(pref.value, "Dulux");
      assert.equal(pref.category, undefined);
      assert.ok(pref.id.length > 0);
      assert.ok(pref.createdAt > 0);
      assert.equal(pref.createdAt, pref.updatedAt);
    });

    it("records a categorised preference", async () => {
      const store = make();
      const pref = await store.add({
        key: "fastener default",
        value: "stainless M6",
        category: "hardware",
      });
      assert.equal(pref.category, "hardware");
    });

    it("rejects a blank key or value", async () => {
      const store = make();
      await assert.rejects(() => store.add({ key: " ", value: "x" }), /key cannot be empty/);
      await assert.rejects(() => store.add({ key: "k", value: " " }), /value cannot be empty/);
    });

    it("clears the category with null, requires a change, and bumps updatedAt", async () => {
      const store = make();
      const pref = await store.add({
        key: "trailer name",
        value: "Big Bertha",
        category: "naming",
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const cleared = await store.update(pref.id, { category: null });
      assert.equal(cleared?.category, undefined);
      assert.ok((cleared?.updatedAt ?? 0) > pref.updatedAt);
      await assert.rejects(() => store.update(pref.id, {}), /at least one changed field/);
    });

    it("returns null for unknown ids and removes a preference", async () => {
      const store = make();
      assert.equal(await store.get("nope"), null);
      assert.equal(await store.update("nope", { value: "x" }), null);
      assert.equal(await store.remove("nope"), null);
      const pref = await store.add({ key: "unit system", value: "metric" });
      assert.equal((await store.remove(pref.id))?.id, pref.id);
      assert.deepEqual(await store.list(), []);
    });
  });
}

describe("JsonPreferenceStore durability", () => {
  it("reads back a categorised preference through a fresh instance", async () => {
    const first = new JsonPreferenceStore(path.join(dir, "preferences.json"));
    const added = await first.add({
      key: "brand voice",
      value: "practical, no fluff",
      category: "branding",
    });
    const reopened = new JsonPreferenceStore(path.join(dir, "preferences.json"));
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, added.id);
    assert.equal(list[0].key, "brand voice");
    assert.equal(list[0].category, "branding");
  });
});
