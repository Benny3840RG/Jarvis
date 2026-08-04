import { randomUUID } from "node:crypto";

import type { Build, BuildInput, BuildStore, BuildUpdate } from "../builds/build.js";
import type {
  BuildLogEntry,
  BuildLogInput,
  BuildLogStore,
  BuildLogUpdate,
} from "../buildLog/buildLogEntry.js";
import type {
  Upgrade,
  UpgradeInput,
  UpgradeStore,
  UpgradeUpdate,
} from "../upgrades/upgrade.js";
import type { Asset, AssetInput, AssetStore, AssetUpdate } from "../assets/asset.js";
import type {
  Preference,
  PreferenceInput,
  PreferenceStore,
  PreferenceUpdate,
} from "../preferences/preference.js";
import type { SmokeWriter } from "./convexSmoke.js";

/** Per-domain result: each stage of the create/update/restart/remove cycle passed. */
export type DomainSmokeResult = {
  created: boolean;
  updated: boolean;
  restartVisible: boolean;
  removed: boolean;
};

export type MemoryDomain =
  | "builds"
  | "buildLogs"
  | "upgrades"
  | "assets"
  | "preferences";

export type MemoryStoresSmokeResult = Record<MemoryDomain, DomainSmokeResult>;

/**
 * Fresh store factories, one per domain. Each call must return a store backed by
 * a new client so restart-visibility genuinely proves durability against the
 * deployment rather than reuse of an in-process cache.
 */
export type MemoryStoreFactories = {
  builds: () => BuildStore;
  buildLogs: () => BuildLogStore;
  upgrades: () => UpgradeStore;
  assets: () => AssetStore;
  preferences: () => PreferenceStore;
};

/** The shared shape of every durable-memory store used by this smoke. */
type SmokeStore<T extends { id: string }, I, U> = {
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
  add(input: I): Promise<T>;
  update(id: string, update: U): Promise<T | null>;
  remove(id: string): Promise<T | null>;
};

type DomainSpec<T extends { id: string }, I, U> = {
  label: MemoryDomain;
  makeStore: () => SmokeStore<T, I, U>;
  input: I;
  update: U;
  /** Throws if the freshly created record does not match the input. */
  checkCreated: (entity: T) => void;
  /** Throws if the updated record does not reflect the update (including cleared fields). */
  checkUpdated: (entity: T) => void;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs a full create -> update -> list -> get -> remove cycle for one domain,
 * building a fresh store for every operation so that visibility across store
 * instances proves the write reached the deployment. Cleans up the created
 * record even when a stage fails.
 */
async function runDomainSmoke<T extends { id: string }, I, U>(
  spec: DomainSpec<T, I, U>,
  write: SmokeWriter,
): Promise<DomainSmokeResult> {
  let createdId: string | undefined;
  let primaryError: Error | undefined;
  let result: DomainSmokeResult | undefined;

  try {
    const created = await spec.makeStore().add(spec.input);
    createdId = created.id;
    spec.checkCreated(created);

    const updated = await spec.makeStore().update(created.id, spec.update);
    requireCondition(updated !== null, `${spec.label}: update returned null for a known id.`);
    requireCondition(updated.id === created.id, `${spec.label}: update changed the record id.`);
    spec.checkUpdated(updated);

    const listed = await spec.makeStore().list();
    const listedEntry = listed.find((entry) => entry.id === created.id);
    requireCondition(
      listedEntry !== undefined,
      `${spec.label}: updated record was not visible from a new store instance.`,
    );
    spec.checkUpdated(listedEntry);

    const fetched = await spec.makeStore().get(created.id);
    requireCondition(
      fetched !== null,
      `${spec.label}: get returned null from a new store instance.`,
    );
    spec.checkUpdated(fetched);

    const removed = await spec.makeStore().remove(created.id);
    requireCondition(
      removed?.id === created.id,
      `${spec.label}: remove did not return the removed record.`,
    );

    const remaining = await spec.makeStore().list();
    requireCondition(
      !remaining.some((entry) => entry.id === created.id),
      `${spec.label}: record remained after removal.`,
    );
    createdId = undefined;

    result = { created: true, updated: true, restartVisible: true, removed: true };
  } catch (error: unknown) {
    primaryError = normalizeError(error);
  }

  const cleanupErrors: unknown[] = [];
  if (createdId !== undefined) {
    try {
      await spec.makeStore().remove(createdId);
      const remaining = await spec.makeStore().list();
      requireCondition(
        !remaining.some((entry) => entry.id === createdId),
        `${spec.label}: record remained after cleanup removal.`,
      );
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      `${spec.label}: smoke cleanup failed.`,
    );
  }
  if (primaryError !== undefined) throw primaryError;
  requireCondition(result !== undefined, `${spec.label}: smoke finished without a result.`);

  write(`Convex smoke passed for ${spec.label}: create, update, restart visibility, remove.`);
  return result;
}

function buildSpecs(
  factories: MemoryStoreFactories,
  marker: string,
  childDomainBuildId: string,
): [
  DomainSpec<Build, BuildInput, BuildUpdate>,
  DomainSpec<BuildLogEntry, BuildLogInput, BuildLogUpdate>,
  DomainSpec<Upgrade, UpgradeInput, UpgradeUpdate>,
  DomainSpec<Asset, AssetInput, AssetUpdate>,
  DomainSpec<Preference, PreferenceInput, PreferenceUpdate>,
] {
  const buildsSpec: DomainSpec<Build, BuildInput, BuildUpdate> = {
    label: "builds",
    makeStore: factories.builds,
    input: { name: `${marker} build`, kind: "shed", description: "before" },
    update: { name: `${marker} build v2`, description: null },
    checkCreated: (build) => {
      requireCondition(build.name === `${marker} build`, "builds: created name mismatch.");
      requireCondition(build.kind === "shed", "builds: created kind mismatch.");
      requireCondition(build.description === "before", "builds: created description mismatch.");
      requireCondition(typeof build.createdAt === "number", "builds: createdAt missing.");
      requireCondition(typeof build.updatedAt === "number", "builds: updatedAt missing.");
    },
    checkUpdated: (build) => {
      requireCondition(build.name === `${marker} build v2`, "builds: updated name mismatch.");
      requireCondition(build.description === undefined, "builds: description was not cleared.");
      requireCondition(typeof build.updatedAt === "number", "builds: updatedAt missing.");
    },
  };

  const buildLogsSpec: DomainSpec<BuildLogEntry, BuildLogInput, BuildLogUpdate> = {
    label: "buildLogs",
    makeStore: factories.buildLogs,
    input: {
      buildId: childDomainBuildId,
      title: `${marker} log`,
      kind: "milestone",
      body: "first",
    },
    update: { title: `${marker} log v2`, body: null },
    checkCreated: (log) => {
      requireCondition(
        log.buildId === childDomainBuildId,
        "buildLogs: created buildId mismatch.",
      );
      requireCondition(log.title === `${marker} log`, "buildLogs: created title mismatch.");
      requireCondition(log.kind === "milestone", "buildLogs: created kind mismatch.");
      requireCondition(log.body === "first", "buildLogs: created body mismatch.");
    },
    checkUpdated: (log) => {
      requireCondition(
        log.buildId === childDomainBuildId,
        "buildLogs: updated buildId mismatch.",
      );
      requireCondition(log.title === `${marker} log v2`, "buildLogs: updated title mismatch.");
      requireCondition(log.body === undefined, "buildLogs: body was not cleared.");
    },
  };

  const upgradesSpec: DomainSpec<Upgrade, UpgradeInput, UpgradeUpdate> = {
    label: "upgrades",
    makeStore: factories.upgrades,
    input: {
      buildId: childDomainBuildId,
      title: `${marker} upgrade`,
      reason: "why",
      parts: ["motor"],
    },
    update: { reason: null, parts: ["motor", "esc"] },
    checkCreated: (upgrade) => {
      requireCondition(
        upgrade.buildId === childDomainBuildId,
        "upgrades: created buildId mismatch.",
      );
      requireCondition(upgrade.title === `${marker} upgrade`, "upgrades: created title mismatch.");
      requireCondition(upgrade.reason === "why", "upgrades: created reason mismatch.");
      requireCondition(
        JSON.stringify(upgrade.parts) === JSON.stringify(["motor"]),
        "upgrades: created parts mismatch.",
      );
    },
    checkUpdated: (upgrade) => {
      requireCondition(
        upgrade.buildId === childDomainBuildId,
        "upgrades: updated buildId mismatch.",
      );
      requireCondition(upgrade.reason === undefined, "upgrades: reason was not cleared.");
      requireCondition(
        JSON.stringify(upgrade.parts) === JSON.stringify(["motor", "esc"]),
        "upgrades: updated parts mismatch.",
      );
    },
  };

  const assetsSpec: DomainSpec<Asset, AssetInput, AssetUpdate> = {
    label: "assets",
    makeStore: factories.assets,
    input: { name: `${marker} asset`, kind: "tool", serviceIntervalDays: 30 },
    update: { serviceIntervalDays: null, lastServicedAt: 1_700_000_000_000 },
    checkCreated: (asset) => {
      requireCondition(asset.name === `${marker} asset`, "assets: created name mismatch.");
      requireCondition(asset.serviceIntervalDays === 30, "assets: created interval mismatch.");
    },
    checkUpdated: (asset) => {
      requireCondition(
        asset.serviceIntervalDays === undefined,
        "assets: serviceIntervalDays was not cleared.",
      );
      requireCondition(
        asset.lastServicedAt === 1_700_000_000_000,
        "assets: lastServicedAt was not set.",
      );
      requireCondition(typeof asset.updatedAt === "number", "assets: updatedAt missing.");
    },
  };

  const preferencesSpec: DomainSpec<Preference, PreferenceInput, PreferenceUpdate> = {
    label: "preferences",
    makeStore: factories.preferences,
    input: { key: `${marker}-key`, value: "v1", category: "smoke" },
    update: { value: "v2", category: null },
    checkCreated: (preference) => {
      requireCondition(preference.key === `${marker}-key`, "preferences: created key mismatch.");
      requireCondition(preference.value === "v1", "preferences: created value mismatch.");
      requireCondition(preference.category === "smoke", "preferences: created category mismatch.");
    },
    checkUpdated: (preference) => {
      requireCondition(preference.value === "v2", "preferences: updated value mismatch.");
      requireCondition(preference.category === undefined, "preferences: category was not cleared.");
      requireCondition(typeof preference.updatedAt === "number", "preferences: updatedAt missing.");
    },
  };

  return [buildsSpec, buildLogsSpec, upgradesSpec, assetsSpec, preferencesSpec];
}

async function removeSupportBuild(
  factories: MemoryStoreFactories,
  buildId: string,
): Promise<void> {
  await factories.builds().remove(buildId);
  const remaining = await factories.builds().list();
  requireCondition(
    !remaining.some((build) => build.id === buildId),
    "builds: support parent remained after cleanup removal.",
  );
}

/**
 * Exercises all five durable-memory Convex stores (builds, build logs, upgrades,
 * assets, preferences) end-to-end against a development deployment. Refuses any
 * non-development deployment before touching a store, and every created record
 * is removed even on failure.
 */
export async function runMemoryStoresSmoke(
  factories: MemoryStoreFactories,
  deployment: string | undefined,
  write: SmokeWriter = (message) => console.log(message),
): Promise<MemoryStoresSmokeResult> {
  if (!deployment?.trim().startsWith("dev:")) {
    throw new Error(
      "Convex smoke test refused: CONVEX_DEPLOYMENT must identify a development deployment (dev:...).",
    );
  }

  const marker = `jarvis-smoke-${randomUUID()}`;
  const [builds] = buildSpecs(factories, marker, `${marker}-placeholder-build`);
  const buildsResult = await runDomainSmoke(builds, write);

  let supportBuildId: string | undefined;
  let primaryError: Error | undefined;
  let childResults: Omit<MemoryStoresSmokeResult, "builds"> | undefined;

  try {
    const supportBuild = await factories.builds().add({
      name: `${marker} child-domain parent`,
      kind: "shed",
      description: "parent for child-domain smoke",
    });
    supportBuildId = supportBuild.id;
    requireCondition(supportBuildId.length > 0, "builds: support parent id missing.");

    const [, buildLogs, upgrades, assets, preferences] = buildSpecs(
      factories,
      marker,
      supportBuildId,
    );
    childResults = {
      buildLogs: await runDomainSmoke(buildLogs, write),
      upgrades: await runDomainSmoke(upgrades, write),
      assets: await runDomainSmoke(assets, write),
      preferences: await runDomainSmoke(preferences, write),
    };
  } catch (error: unknown) {
    primaryError = normalizeError(error);
  }

  const cleanupErrors: unknown[] = [];
  if (supportBuildId !== undefined) {
    try {
      await removeSupportBuild(factories, supportBuildId);
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      "builds: support parent cleanup failed.",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  requireCondition(
    childResults !== undefined,
    "memory stores smoke finished without child-domain results.",
  );

  const result: MemoryStoresSmokeResult = {
    builds: buildsResult,
    ...childResults,
  };

  write("Convex smoke passed for all five durable-memory domains.");
  return result;
}
