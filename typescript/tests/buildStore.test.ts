import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryBuildStore } from "../src/builds/inMemoryBuildStore.js";
import { JsonBuildStore } from "../src/builds/jsonBuildStore.js";
import type { BuildStore } from "../src/builds/build.js";

let dir: string;

function stores(): { name: string; make: () => BuildStore }[] {
  return [
    { name: "JsonBuildStore", make: () => new JsonBuildStore(path.join(dir, "builds.json")) },
    { name: "InMemoryBuildStore", make: () => new InMemoryBuildStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-builds-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("adds a build with defaults and trims text", async () => {
      const store = make();
      const build = await store.add({
        name: "  Rock crawler  ",
        kind: "  RC crawler  ",
        nickname: "  The Goat  ",
      });
      assert.equal(build.name, "Rock crawler");
      assert.equal(build.kind, "RC crawler");
      assert.equal(build.status, "planning");
      assert.equal(build.nickname, "The Goat");
      assert.equal(build.description, undefined);
      assert.ok(build.id.length > 0);
      assert.equal(build.createdAt, build.updatedAt);
    });

    it("rejects a blank name or kind", async () => {
      const store = make();
      await assert.rejects(() => store.add({ name: " ", kind: "trailer" }), /name cannot be empty/);
      await assert.rejects(() => store.add({ name: "Trailer", kind: " " }), /kind cannot be empty/);
    });

    it("moves through statuses and clears optional text with null", async () => {
      const store = make();
      const build = await store.add({
        name: "Gull-wing trailer",
        kind: "trailer",
        description: "modular fit-out",
        notes: "check axle rating",
      });
      const active = await store.update(build.id, { status: "active" });
      assert.equal(active?.status, "active");
      const cleared = await store.update(build.id, { description: null, notes: null });
      assert.equal(cleared?.description, undefined);
      assert.equal(cleared?.notes, undefined);
      const shelved = await store.update(build.id, { status: "shelved" });
      assert.equal(shelved?.status, "shelved");
    });

    it("rejects an empty update on an existing build", async () => {
      const store = make();
      const build = await store.add({ name: "Bench", kind: "tool" });
      await assert.rejects(() => store.update(build.id, {}), /at least one changed field/);
    });

    it("returns null for unknown ids and removes a build", async () => {
      const store = make();
      assert.equal(await store.get("nope"), null);
      assert.equal(await store.update("nope", { status: "active" }), null);
      assert.equal(await store.remove("nope"), null);
      const build = await store.add({ name: "Sprayer rig", kind: "tool" });
      assert.equal((await store.remove(build.id))?.id, build.id);
      assert.deepEqual(await store.list(), []);
    });
  });
}

describe("JsonBuildStore durability", () => {
  it("reads back through a fresh instance", async () => {
    const first = new JsonBuildStore(path.join(dir, "builds.json"));
    const added = await first.add({
      name: "Rock crawler",
      kind: "RC crawler",
      status: "active",
      nickname: "The Goat",
    });
    const reopened = new JsonBuildStore(path.join(dir, "builds.json"));
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, added.id);
    assert.equal(list[0].status, "active");
    assert.equal(list[0].nickname, "The Goat");
  });
});
