import type { Build, BuildStore } from "../builds/build.js";
import type { BuildLogEntry, BuildLogStore } from "../buildLog/buildLogEntry.js";
import type { Upgrade, UpgradeStore } from "../upgrades/upgrade.js";
import type { Asset, AssetStore } from "../assets/asset.js";
import type { Preference, PreferenceStore } from "../preferences/preference.js";

export type MemoryStoreBundle = {
  builds: BuildStore;
  buildLogs: BuildLogStore;
  upgrades: UpgradeStore;
  assets: AssetStore;
  preferences: PreferenceStore;
};

export type ImportSummary = {
  builds: number;
  buildLogs: number;
  upgrades: number;
  assets: number;
  preferences: number;
};

/**
 * Carries every source record over to the target as a plain input — the record's
 * original id, createdAt and updatedAt are NOT preserved (no store's add() accepts
 * an override for them). Domains with a first-class occurredAt field (build logs,
 * upgrades) keep that value, since it is distinct from createdAt and is a normal
 * input field. This is a one-shot data carry-over, not a byte-for-byte clone.
 *
 * Build logs and upgrades reference a build by id, so builds are copied first and
 * their old-id -> new-id map is threaded through to re-point those references at
 * the target's own build ids, rather than copying the now-meaningless source id.
 * Every buildId reference is validated against the source's own builds before
 * anything is written to the target (see `validateBuildReferences`), so a source
 * with a dangling reference is refused before the target is touched at all.
 */
function validateBuildReferences(
  builds: readonly Build[],
  buildLogs: readonly BuildLogEntry[],
  upgrades: readonly Upgrade[],
): void {
  const buildIds = new Set(builds.map((build) => build.id));
  for (const log of buildLogs) {
    if (!buildIds.has(log.buildId)) {
      throw new Error(
        `Import refused: build log ${log.id} references unknown build ${log.buildId}.`,
      );
    }
  }
  for (const upgrade of upgrades) {
    if (!buildIds.has(upgrade.buildId)) {
      throw new Error(
        `Import refused: upgrade ${upgrade.id} references unknown build ${upgrade.buildId}.`,
      );
    }
  }
}

async function copyBuilds(
  records: readonly Build[],
  target: BuildStore,
): Promise<{ count: number; buildIds: ReadonlyMap<string, string> }> {
  const buildIds = new Map<string, string>();
  for (const build of records) {
    const created = await target.add({
      name: build.name,
      kind: build.kind,
      status: build.status,
      ...(build.description === undefined ? {} : { description: build.description }),
      ...(build.nickname === undefined ? {} : { nickname: build.nickname }),
      ...(build.notes === undefined ? {} : { notes: build.notes }),
    });
    buildIds.set(build.id, created.id);
  }
  return { count: records.length, buildIds };
}

async function copyBuildLogs(
  records: readonly BuildLogEntry[],
  target: BuildLogStore,
  buildIds: ReadonlyMap<string, string>,
): Promise<number> {
  for (const log of records) {
    const buildId = buildIds.get(log.buildId);
    if (buildId === undefined) {
      // Unreachable: validateBuildReferences already checked every buildId.
      throw new Error(
        `Import refused: build log ${log.id} references unknown build ${log.buildId}.`,
      );
    }
    await target.add({
      buildId,
      title: log.title,
      kind: log.kind,
      ...(log.body === undefined ? {} : { body: log.body }),
      ...(log.occurredAt === undefined ? {} : { occurredAt: log.occurredAt }),
    });
  }
  return records.length;
}

async function copyUpgrades(
  records: readonly Upgrade[],
  target: UpgradeStore,
  buildIds: ReadonlyMap<string, string>,
): Promise<number> {
  for (const upgrade of records) {
    const buildId = buildIds.get(upgrade.buildId);
    if (buildId === undefined) {
      // Unreachable: validateBuildReferences already checked every buildId.
      throw new Error(
        `Import refused: upgrade ${upgrade.id} references unknown build ${upgrade.buildId}.`,
      );
    }
    await target.add({
      buildId,
      title: upgrade.title,
      ...(upgrade.reason === undefined ? {} : { reason: upgrade.reason }),
      ...(upgrade.beforeState === undefined ? {} : { beforeState: upgrade.beforeState }),
      ...(upgrade.afterState === undefined ? {} : { afterState: upgrade.afterState }),
      ...(upgrade.outcome === undefined ? {} : { outcome: upgrade.outcome }),
      ...(upgrade.parts === undefined ? {} : { parts: upgrade.parts }),
      ...(upgrade.version === undefined ? {} : { version: upgrade.version }),
      ...(upgrade.occurredAt === undefined ? {} : { occurredAt: upgrade.occurredAt }),
    });
  }
  return records.length;
}

async function copyAssets(source: AssetStore, target: AssetStore): Promise<number> {
  const records: Asset[] = await source.list();
  for (const asset of records) {
    await target.add({
      name: asset.name,
      kind: asset.kind,
      ...(asset.serviceIntervalDays === undefined
        ? {}
        : { serviceIntervalDays: asset.serviceIntervalDays }),
      ...(asset.lastServicedAt === undefined ? {} : { lastServicedAt: asset.lastServicedAt }),
      ...(asset.notes === undefined ? {} : { notes: asset.notes }),
    });
  }
  return records.length;
}

async function copyPreferences(source: PreferenceStore, target: PreferenceStore): Promise<number> {
  const records: Preference[] = await source.list();
  for (const preference of records) {
    await target.add({
      key: preference.key,
      value: preference.value,
      ...(preference.category === undefined ? {} : { category: preference.category }),
    });
  }
  return records.length;
}

/**
 * Copies every durable-memory record from `source` into `target`, one domain at
 * a time. Refuses to write anything if any target domain already holds records,
 * so a second run against a partially- or fully-migrated target fails safely
 * rather than duplicating data — there is no id-based dedup, because the target
 * assigns its own ids on insert.
 */
export async function importMemoryStores(
  source: MemoryStoreBundle,
  target: MemoryStoreBundle,
): Promise<ImportSummary> {
  const [existingBuilds, existingBuildLogs, existingUpgrades, existingAssets, existingPreferences] =
    await Promise.all([
      target.builds.list(),
      target.buildLogs.list(),
      target.upgrades.list(),
      target.assets.list(),
      target.preferences.list(),
    ]);

  const nonEmpty: string[] = [];
  if (existingBuilds.length > 0) nonEmpty.push(`builds (${existingBuilds.length})`);
  if (existingBuildLogs.length > 0) nonEmpty.push(`buildLogs (${existingBuildLogs.length})`);
  if (existingUpgrades.length > 0) nonEmpty.push(`upgrades (${existingUpgrades.length})`);
  if (existingAssets.length > 0) nonEmpty.push(`assets (${existingAssets.length})`);
  if (existingPreferences.length > 0) nonEmpty.push(`preferences (${existingPreferences.length})`);
  if (nonEmpty.length > 0) {
    throw new Error(
      `Import refused: target already has records in ${nonEmpty.join(", ")}. Import only runs into an empty target.`,
    );
  }

  const [sourceBuilds, sourceBuildLogs, sourceUpgrades] = await Promise.all([
    source.builds.list(),
    source.buildLogs.list(),
    source.upgrades.list(),
  ]);
  // Validate every buildId reference before writing anything, so a dangling
  // reference refuses cleanly rather than leaving the target half-populated.
  validateBuildReferences(sourceBuilds, sourceBuildLogs, sourceUpgrades);

  const { count: buildCount, buildIds } = await copyBuilds(sourceBuilds, target.builds);
  return {
    builds: buildCount,
    buildLogs: await copyBuildLogs(sourceBuildLogs, target.buildLogs, buildIds),
    upgrades: await copyUpgrades(sourceUpgrades, target.upgrades, buildIds),
    assets: await copyAssets(source.assets, target.assets),
    preferences: await copyPreferences(source.preferences, target.preferences),
  };
}
