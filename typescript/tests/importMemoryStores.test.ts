import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryAssetStore } from "../src/assets/inMemoryAssetStore.js";
import { InMemoryBuildLogStore } from "../src/buildLog/inMemoryBuildLogStore.js";
import { InMemoryBuildStore } from "../src/builds/inMemoryBuildStore.js";
import { InMemoryPreferenceStore } from "../src/preferences/inMemoryPreferenceStore.js";
import { InMemoryUpgradeStore } from "../src/upgrades/inMemoryUpgradeStore.js";
import { importMemoryStores, type MemoryStoreBundle } from "../src/importer/importMemoryStores.js";

function emptyBundle(): MemoryStoreBundle {
  return {
    builds: new InMemoryBuildStore(),
    buildLogs: new InMemoryBuildLogStore(),
    upgrades: new InMemoryUpgradeStore(),
    assets: new InMemoryAssetStore(),
    preferences: new InMemoryPreferenceStore(),
  };
}

describe("importMemoryStores", () => {
  it("copies every domain's records into an empty target", async () => {
    const source = emptyBundle();
    await source.builds.add({ name: "Trailer", kind: "shed", description: "before" });
    await source.buildLogs.add({
      buildId: "b-1",
      title: "First weld",
      kind: "milestone",
      body: "went well",
      occurredAt: 1000,
    });
    await source.upgrades.add({
      buildId: "b-1",
      title: "New axle",
      reason: "stronger",
      parts: ["axle", "hub"],
    });
    await source.assets.add({ name: "Angle grinder", kind: "tool", serviceIntervalDays: 60 });
    await source.preferences.add({ key: "paint-brand", value: "Dulux", category: "paint" });

    const target = emptyBundle();
    const summary = await importMemoryStores(source, target);

    assert.deepEqual(summary, {
      builds: 1,
      buildLogs: 1,
      upgrades: 1,
      assets: 1,
      preferences: 1,
    });

    const [builds, buildLogs, upgrades, assets, preferences] = await Promise.all([
      target.builds.list(),
      target.buildLogs.list(),
      target.upgrades.list(),
      target.assets.list(),
      target.preferences.list(),
    ]);

    assert.equal(builds[0]?.name, "Trailer");
    assert.equal(builds[0]?.description, "before");
    assert.equal(buildLogs[0]?.title, "First weld");
    assert.equal(buildLogs[0]?.occurredAt, 1000);
    assert.equal(upgrades[0]?.title, "New axle");
    assert.deepEqual(upgrades[0]?.parts, ["axle", "hub"]);
    assert.equal(assets[0]?.serviceIntervalDays, 60);
    assert.equal(preferences[0]?.category, "paint");

    // The target assigns its own ids — the migrated record is not a clone of the source id.
    const sourceBuild = (await source.builds.list())[0];
    assert.notEqual(builds[0]?.id, sourceBuild?.id);
  });

  it("returns all-zero counts and writes nothing when the source is empty", async () => {
    const source = emptyBundle();
    const target = emptyBundle();

    const summary = await importMemoryStores(source, target);

    assert.deepEqual(summary, {
      builds: 0,
      buildLogs: 0,
      upgrades: 0,
      assets: 0,
      preferences: 0,
    });
    assert.deepEqual(await target.builds.list(), []);
  });

  it("refuses to import when the target already has records in any domain", async () => {
    const source = emptyBundle();
    await source.builds.add({ name: "Trailer", kind: "shed" });

    const target = emptyBundle();
    await target.preferences.add({ key: "existing", value: "already here" });

    await assert.rejects(
      () => importMemoryStores(source, target),
      /already has records in preferences \(1\)/,
    );

    // Nothing should have been written to any domain — the check runs before any copy.
    assert.deepEqual(await target.builds.list(), []);
  });
});
