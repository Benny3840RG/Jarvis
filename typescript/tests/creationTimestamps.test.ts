import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { InMemoryBuildLogStore } from "../src/buildLog/inMemoryBuildLogStore.js";
import { JsonBuildLogStore } from "../src/buildLog/jsonBuildLogStore.js";
import { InMemoryUpgradeStore } from "../src/upgrades/inMemoryUpgradeStore.js";
import { JsonUpgradeStore } from "../src/upgrades/jsonUpgradeStore.js";

const stores = [
  {
    name: "JsonBuildLogStore",
    make: (dir: string) => new JsonBuildLogStore(path.join(dir, "build-logs.json")),
  },
  { name: "InMemoryBuildLogStore", make: (_dir: string) => new InMemoryBuildLogStore() },
  {
    name: "JsonUpgradeStore",
    make: (dir: string) => new JsonUpgradeStore(path.join(dir, "upgrades.json")),
  },
  { name: "InMemoryUpgradeStore", make: (_dir: string) => new InMemoryUpgradeStore() },
];
for (const { name, make } of stores) {
  it(`${name} uses one creation instant even when the clock advances between reads`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "jarvis-creation-clock-"));
    try {
      let now = 1_700_000_000_000;
      t.mock.method(Date, "now", () => now++);
      const store = make(dir);
      const entry = await store.add({ buildId: "b1", title: "One creation instant" });
      assert.equal(entry.updatedAt, entry.createdAt);
      const persisted = await store.get(entry.id);
      assert.equal(persisted?.createdAt, entry.createdAt);
      assert.equal(persisted?.updatedAt, entry.createdAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
