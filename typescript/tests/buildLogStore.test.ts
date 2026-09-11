import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryBuildLogStore } from "../src/buildLog/inMemoryBuildLogStore.js";
import { JsonBuildLogStore } from "../src/buildLog/jsonBuildLogStore.js";
import type { BuildLogStore } from "../src/buildLog/buildLogEntry.js";

let dir: string;

function stores(): { name: string; make: () => BuildLogStore }[] {
  return [
    {
      name: "JsonBuildLogStore",
      make: () => new JsonBuildLogStore(path.join(dir, "build-logs.json")),
    },
    { name: "InMemoryBuildLogStore", make: () => new InMemoryBuildLogStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-build-logs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("adds an entry with the default kind and trims text", async () => {
      const store = make();
      const entry = await store.add({ buildId: "b1", title: "  First test run  " });
      assert.equal(entry.buildId, "b1");
      assert.equal(entry.kind, "note");
      assert.equal(entry.title, "First test run");
      assert.equal(entry.body, undefined);
      assert.equal(entry.occurredAt, undefined);
      assert.ok(entry.id.length > 0);
      assert.ok(entry.createdAt > 0);
    });

    it("records a typed milestone with a body and an occurred time", async () => {
      const store = make();
      const when = Date.UTC(2026, 3, 12, 9, 0, 0);
      const entry = await store.add({
        buildId: "b1",
        kind: "milestone",
        title: "First clean crawl",
        body: "New servo held steering authority all the way up the ledge.",
        occurredAt: when,
      });
      assert.equal(entry.kind, "milestone");
      assert.equal(entry.occurredAt, when);
      assert.match(entry.body ?? "", /servo/);
    });

    it("rejects a blank buildId or title, a bad kind, and a non-numeric occurredAt", async () => {
      const store = make();
      await assert.rejects(
        () => store.add({ buildId: " ", title: "X" }),
        /buildId cannot be empty/,
      );
      await assert.rejects(() => store.add({ buildId: "b1", title: " " }), /title cannot be empty/);
      await assert.rejects(
        // @ts-expect-error deliberately invalid kind
        () => store.add({ buildId: "b1", title: "X", kind: "legend" }),
        /kind must be one of/,
      );
      await assert.rejects(
        // @ts-expect-error occurredAt must be a number
        () => store.add({ buildId: "b1", title: "X", occurredAt: "yesterday" }),
        /occurredAt must be a finite timestamp/,
      );
    });

    it("clears body and occurredAt with null and requires a change", async () => {
      const store = make();
      const entry = await store.add({
        buildId: "b1",
        title: "Snapped a link",
        kind: "failure",
        body: "Overtightened.",
        occurredAt: 1000,
      });
      const cleared = await store.update(entry.id, { body: null, occurredAt: null });
      assert.equal(cleared?.body, undefined);
      assert.equal(cleared?.occurredAt, undefined);
      await assert.rejects(() => store.update(entry.id, {}), /at least one changed field/);
    });

    it("returns null for unknown ids and removes an entry", async () => {
      const store = make();
      assert.equal(await store.get("nope"), null);
      assert.equal(await store.update("nope", { title: "x" }), null);
      assert.equal(await store.remove("nope"), null);
      const entry = await store.add({ buildId: "b1", title: "Bought it home" });
      assert.equal((await store.remove(entry.id))?.id, entry.id);
      assert.deepEqual(await store.list(), []);
    });
  });
}

describe("JsonBuildLogStore durability", () => {
  it("reads back a typed entry through a fresh instance", async () => {
    const first = new JsonBuildLogStore(path.join(dir, "build-logs.json"));
    const added = await first.add({
      buildId: "b1",
      kind: "origin",
      title: "Why this build exists",
      body: "Wanted a crawler that could handle the back paddock.",
      occurredAt: 1234,
    });
    const reopened = new JsonBuildLogStore(path.join(dir, "build-logs.json"));
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, added.id);
    assert.equal(list[0].kind, "origin");
    assert.equal(list[0].occurredAt, 1234);
  });
});
