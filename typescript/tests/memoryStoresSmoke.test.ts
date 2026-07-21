import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryAssetStore } from "../src/assets/inMemoryAssetStore.js";
import { InMemoryBuildLogStore } from "../src/buildLog/inMemoryBuildLogStore.js";
import { InMemoryBuildStore } from "../src/builds/inMemoryBuildStore.js";
import { InMemoryPreferenceStore } from "../src/preferences/inMemoryPreferenceStore.js";
import { InMemoryUpgradeStore } from "../src/upgrades/inMemoryUpgradeStore.js";
import type { Build, BuildUpdate } from "../src/builds/build.js";
import { runMemoryStoresSmoke, type MemoryStoreFactories } from "../src/tools/memoryStoresSmoke.js";

type RealStores = {
  builds: InMemoryBuildStore;
  buildLogs: InMemoryBuildLogStore;
  upgrades: InMemoryUpgradeStore;
  assets: InMemoryAssetStore;
  preferences: InMemoryPreferenceStore;
};

/**
 * Shared in-memory stores plus factories that hand back the same instance each
 * call, so the smoke runner is exercised against real store implementations
 * rather than mocks.
 */
function realStores(overrides: Partial<RealStores> = {}): {
  stores: RealStores;
  factories: MemoryStoreFactories;
} {
  const stores: RealStores = {
    builds: overrides.builds ?? new InMemoryBuildStore(),
    buildLogs: overrides.buildLogs ?? new InMemoryBuildLogStore(),
    upgrades: overrides.upgrades ?? new InMemoryUpgradeStore(),
    assets: overrides.assets ?? new InMemoryAssetStore(),
    preferences: overrides.preferences ?? new InMemoryPreferenceStore(),
  };
  return {
    stores,
    factories: {
      builds: () => stores.builds,
      buildLogs: () => stores.buildLogs,
      upgrades: () => stores.upgrades,
      assets: () => stores.assets,
      preferences: () => stores.preferences,
    },
  };
}

describe("Memory stores smoke runner", () => {
  it("refuses non-development deployments before touching any store", async () => {
    let factoryCalls = 0;
    const factories: MemoryStoreFactories = {
      builds: () => {
        factoryCalls += 1;
        return new InMemoryBuildStore();
      },
      buildLogs: () => {
        factoryCalls += 1;
        return new InMemoryBuildLogStore();
      },
      upgrades: () => {
        factoryCalls += 1;
        return new InMemoryUpgradeStore();
      },
      assets: () => {
        factoryCalls += 1;
        return new InMemoryAssetStore();
      },
      preferences: () => {
        factoryCalls += 1;
        return new InMemoryPreferenceStore();
      },
    };

    await assert.rejects(
      () => runMemoryStoresSmoke(factories, "prod:jarvis", () => undefined),
      /development deployment/,
    );
    assert.equal(factoryCalls, 0);
  });

  it("runs the full cycle for all five domains and leaves nothing behind", async () => {
    const { stores, factories } = realStores();
    const messages: string[] = [];

    const result = await runMemoryStoresSmoke(factories, "dev:test", (message) =>
      messages.push(message),
    );

    for (const domain of ["builds", "buildLogs", "upgrades", "assets", "preferences"] as const) {
      assert.deepEqual(
        result[domain],
        { created: true, updated: true, restartVisible: true, removed: true },
        `${domain} did not complete every stage`,
      );
    }

    assert.deepEqual(await stores.builds.list(), []);
    assert.deepEqual(await stores.buildLogs.list(), []);
    assert.deepEqual(await stores.upgrades.list(), []);
    assert.deepEqual(await stores.assets.list(), []);
    assert.deepEqual(await stores.preferences.list(), []);

    assert(messages.some((message) => message.includes("all five durable-memory domains")));
  });

  it("removes the created record when a later stage fails", async () => {
    class FailingUpdateBuildStore extends InMemoryBuildStore {
      override update(_id: string, _update: BuildUpdate): Promise<Build | null> {
        return Promise.reject(new Error("forced update failure"));
      }
    }

    const builds = new FailingUpdateBuildStore();
    const { stores, factories } = realStores({ builds });

    await assert.rejects(
      () => runMemoryStoresSmoke(factories, "dev:test", () => undefined),
      /forced update failure/,
    );

    // The record created before the forced failure must have been cleaned up,
    // and the later domains must never have run.
    assert.deepEqual(await stores.builds.list(), []);
    assert.deepEqual(await stores.buildLogs.list(), []);
  });

  it("fails when remove returns the record without deleting it", async () => {
    class FirstRemoveDoesNotDeleteBuildStore extends InMemoryBuildStore {
      private removeCalls = 0;

      override async remove(id: string): Promise<Build | null> {
        this.removeCalls += 1;
        if (this.removeCalls === 1) return this.get(id);
        return super.remove(id);
      }
    }

    const builds = new FirstRemoveDoesNotDeleteBuildStore();
    const { stores, factories } = realStores({ builds });

    await assert.rejects(
      () => runMemoryStoresSmoke(factories, "dev:test", () => undefined),
      /record remained after removal/,
    );

    // Cleanup retries removal after the failed verification and leaves no smoke record behind.
    assert.deepEqual(await stores.builds.list(), []);
    assert.deepEqual(await stores.buildLogs.list(), []);
  });
});
