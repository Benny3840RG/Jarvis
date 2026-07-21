import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryProjectStore } from "../src/projects/inMemoryProjectStore.js";
import { JsonProjectStore } from "../src/projects/jsonProjectStore.js";
import type { ProjectStore } from "../src/projects/project.js";

let dir: string;

function stores(): { name: string; make: () => ProjectStore }[] {
  return [
    { name: "JsonProjectStore", make: () => new JsonProjectStore(path.join(dir, "projects.json")) },
    { name: "InMemoryProjectStore", make: () => new InMemoryProjectStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-projects-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("adds a project with defaults and required fields", async () => {
      const store = make();
      const project = await store.add({ clientId: "c1", title: "  Deck rebuild  " });
      assert.equal(project.clientId, "c1");
      assert.equal(project.title, "Deck rebuild");
      assert.equal(project.status, "lead");
      assert.ok(project.id.length > 0);
      assert.equal(project.createdAt, project.updatedAt);
    });

    it("rejects blank clientId or title", async () => {
      const store = make();
      await assert.rejects(
        () => store.add({ clientId: " ", title: "X" }),
        /clientId cannot be empty/,
      );
      await assert.rejects(
        () => store.add({ clientId: "c1", title: " " }),
        /title cannot be empty/,
      );
    });

    it("updates status and notes, clears notes with null, requires a change", async () => {
      const store = make();
      const project = await store.add({ clientId: "c1", title: "Fence", notes: "quote sent" });
      const updated = await store.update(project.id, { status: "active", notes: null });
      assert.equal(updated?.status, "active");
      assert.equal(updated?.notes, undefined);
      await assert.rejects(
        () => store.update(project.id, {}),
        /requires a clientId, title, status/,
      );
    });

    it("returns null for unknown ids and removes a project", async () => {
      const store = make();
      assert.equal(await store.get("nope"), null);
      assert.equal(await store.update("nope", { status: "done" }), null);
      assert.equal(await store.remove("nope"), null);
      const project = await store.add({ clientId: "c1", title: "Pergola" });
      assert.equal((await store.remove(project.id))?.id, project.id);
      assert.deepEqual(await store.list(), []);
    });
  });
}

describe("JsonProjectStore durability", () => {
  it("reads back through a fresh instance", async () => {
    const first = new JsonProjectStore(path.join(dir, "projects.json"));
    const added = await first.add({ clientId: "c1", title: "Retaining wall", status: "quoted" });
    const reopened = new JsonProjectStore(path.join(dir, "projects.json"));
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, added.id);
    assert.equal(list[0].status, "quoted");
  });
});
