import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  ARCHIVE_GROUPS,
  ArchiveManifestError,
  V4_CONTRACT_VERSION,
  assertRecoverable,
} from "../src/backup/archiveManifest.js";
import { StrictBackupError } from "../src/backup/strictValues.js";
import {
  buildArchiveV4,
  parseArchiveV4,
  readArchiveV4File,
  sealVerifiedArchive,
  writeArchiveV4File,
  type ArchiveV4,
} from "../src/backup/v4/archive.js";
import {
  CAPTURE_LOCK_ORDER,
  captureJsonGroups,
  readCoreGroup,
  readMemoryGroup,
  resolveJsonSourceConfig,
  type CapturePaths,
} from "../src/backup/v4/jsonSource.js";
import { RESTORE_MARKER, restoreArchiveV4 } from "../src/backup/v4/restore.js";
import { archiveV4Usage, isArchiveV4Command } from "../src/tools/runBackupV4.js";
import { JSONPersistence } from "../src/persistence/persistence.js";
import { JsonBuildStore } from "../src/builds/jsonBuildStore.js";

const CREATED_AT = new Date("2026-09-10T12:00:00.000Z");

/** Groups not yet captured from JSON storage. Every archive this stage writes lacks them. */
const ABSENT_GROUPS = ["notesAndEvidence", "orchestration", "quoteAggregate"];

const scratchRoots: string[] = [];

after(async () => {
  await Promise.all(scratchRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-v4-"));
  scratchRoots.push(dir);
  return dir;
}

function pathsIn(dir: string): CapturePaths {
  return {
    state: path.join(dir, "jarvis-state.json"),
    builds: path.join(dir, "jarvis-builds.json"),
    buildLogs: path.join(dir, "jarvis-build-logs.json"),
    upgrades: path.join(dir, "jarvis-upgrades.json"),
    assets: path.join(dir, "jarvis-assets.json"),
    preferences: path.join(dir, "jarvis-preferences.json"),
    clients: path.join(dir, "jarvis-clients.json"),
    properties: path.join(dir, "jarvis-properties.json"),
    projects: path.join(dir, "jarvis-projects.json"),
    quotes: path.join(dir, "jarvis-quotes.json"),
    invoices: path.join(dir, "jarvis-invoices.json"),
    enquiries: path.join(dir, "jarvis-enquiries.json"),
    errands: path.join(dir, "jarvis-errands.json"),
    businessSettings: path.join(dir, "jarvis-business-settings.json"),
  };
}

/**
 * Deliberately unsorted ids and irregular timestamps: the contract is that the
 * archive preserves what is on disk verbatim, not a tidied version of it.
 */
const FIXTURE = {
  state: {
    version: 2,
    state: { mode: "workshop", lastBriefAt: 1_756_000_000_123, pinned: ["quotes", "invoices"] },
    tasks: [
      {
        id: "task-z",
        title: "Order steel",
        completed: false,
        category: "work",
        createdAt: 1_700_000_000_001,
      },
      {
        id: "task-a",
        title: "Call supplier",
        completed: true,
        category: "work",
        createdAt: 1_600_000_000_002,
      },
    ],
    reminders: [
      {
        id: "rem-2",
        title: "Site visit",
        dueRaw: "tomorrow 9am",
        dueAt: 1_800_000_000_000,
        dueTimezone: "Europe/London",
        createdAt: 1_700_000_000_003,
      },
      { id: "rem-1", title: "Renew insurance", createdAt: 1_500_000_000_004 },
    ],
  },
  builds: {
    version: 1,
    builds: [
      {
        id: "build-2",
        name: "Bench press rig",
        kind: "workshop",
        status: "active",
        description: "Welded frame",
        createdAt: 1_710_000_000_001,
        updatedAt: 1_710_000_000_002,
      },
      {
        id: "build-1",
        name: "Van shelving",
        kind: "vehicle",
        status: "planning",
        createdAt: 1_705_000_000_001,
        updatedAt: 1_705_000_000_001,
      },
    ],
  },
  buildLogs: {
    version: 1,
    entries: [
      {
        id: "log-1",
        buildId: "build-1",
        kind: "note",
        title: "Measured bay",
        body: "1180mm clear",
        occurredAt: 1_711_000_000_000,
        createdAt: 1_711_000_000_001,
        updatedAt: 1_711_000_000_001,
      },
    ],
  },
  upgrades: {
    version: 1,
    entries: [
      {
        id: "upg-1",
        buildId: "build-2",
        title: "Heavier uprights",
        reason: "Flex under load",
        parts: ["50x50 box", "M12 bolts"],
        version: "v2",
        occurredAt: 1_712_000_000_000,
        createdAt: 1_712_000_000_001,
        updatedAt: 1_712_000_000_002,
      },
    ],
  },
  assets: {
    version: 1,
    entries: [
      {
        id: "asset-1",
        name: "Transit",
        kind: "vehicle",
        serviceIntervalDays: 180,
        lastServicedAt: 1_713_000_000_000,
        createdAt: 1_713_000_000_001,
        updatedAt: 1_713_000_000_002,
      },
    ],
  },
  preferences: {
    version: 1,
    entries: [
      {
        id: "pref-1",
        key: "units",
        value: "metric",
        category: "workshop",
        createdAt: 1_714_000_000_001,
        updatedAt: 1_714_000_000_002,
      },
    ],
  },
} as const;

async function writeSource(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const paths = pathsIn(dir);
  const documents: Record<string, unknown> = { ...FIXTURE, ...overrides };
  for (const [key, target] of Object.entries(paths)) {
    const document = documents[key];
    // `null` means "this file has never existed"; absent means the same, for the
    // business files this suite does not exercise.
    if (document === null || document === undefined) continue;
    await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}

async function captureFixture(overrides: Record<string, unknown> = {}): Promise<ArchiveV4> {
  const dir = await scratch();
  await writeSource(dir, overrides);
  return buildArchiveV4(await captureJsonGroups(pathsIn(dir)), CREATED_AT);
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

describe("archive v4 — core and memory capture", () => {
  it("preserves every id, timestamp and array order verbatim", async () => {
    const archive = await captureFixture();
    assert.deepEqual(archive.groups.core?.state, FIXTURE.state.state);
    assert.deepEqual(
      archive.groups.core?.tasks.map((task) => task.id),
      ["task-z", "task-a"],
    );
    assert.deepEqual(archive.groups.core?.tasks[1], FIXTURE.state.tasks[1]);
    assert.deepEqual(archive.groups.core?.reminders[0], FIXTURE.state.reminders[0]);
    assert.deepEqual(
      archive.groups.memory?.builds.map((build) => build.id),
      ["build-2", "build-1"],
    );
    assert.deepEqual(archive.groups.memory?.upgrades[0], FIXTURE.upgrades.entries[0]);
    assert.deepEqual(archive.groups.memory?.assets[0], FIXTURE.assets.entries[0]);
    assert.deepEqual(archive.groups.memory?.preferences[0], FIXTURE.preferences.entries[0]);
  });

  it("records counts and a consistent-snapshot flag for both captured groups", async () => {
    const archive = await captureFixture();
    const core = archive.manifest.groups.find((entry) => entry.group === "core");
    const memory = archive.manifest.groups.find((entry) => entry.group === "memory");
    assert.deepEqual(core?.counts, { stateKeys: 3, tasks: 2, reminders: 2 });
    assert.deepEqual(memory?.counts, {
      builds: 2,
      buildLogs: 1,
      upgrades: 1,
      assets: 1,
      preferences: 1,
    });
    assert.equal(core?.consistentSnapshot, true);
    assert.equal(memory?.consistentSnapshot, true);
  });

  it("treats a never-created file as empty but never invents records", async () => {
    const archive = await captureFixture({ state: null, assets: null });
    assert.deepEqual(archive.groups.core, { state: {}, tasks: [], reminders: [] });
    assert.deepEqual(archive.groups.memory?.assets, []);
    assert.equal(archive.groups.memory?.builds.length, 2);
  });

  it("locks every covered file in one fixed order", () => {
    assert.deepEqual([...CAPTURE_LOCK_ORDER], Object.keys(pathsIn("/x")));
  });

  it("refuses to capture while another writer holds a covered file's lock", async () => {
    const dir = await scratch();
    await writeSource(dir);
    // A live pid, so the lock is not reclaimed as stale.
    await writeFile(
      `${pathsIn(dir).builds}.lock`,
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: "held-by-test" }),
      "utf8",
    );
    await assert.rejects(
      captureJsonGroups(pathsIn(dir), { lockTimeoutMs: 50 }),
      (error: unknown) =>
        error instanceof StrictBackupError &&
        /could not establish a coherent snapshot/.test(error.message),
    );
  });

  it("refuses a provider whose data it cannot read", () => {
    assert.throws(() => resolveJsonSourceConfig("convex"), StrictBackupError);
    assert.doesNotThrow(() => resolveJsonSourceConfig("json"));
  });
});

describe("archive v4 — strict reads never silently drop data", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "an unknown field on a task",
      { state: { ...FIXTURE.state, tasks: [{ ...FIXTURE.state.tasks[0], priority: "high" }] } },
      /unsupported field "priority"/,
    ],
    [
      "an invalid record the runtime store would skip",
      { state: { ...FIXTURE.state, tasks: [{ id: "t", title: "x", completed: false }] } },
      /invalid category/,
    ],
    [
      "a duplicate id",
      { state: { ...FIXTURE.state, tasks: [FIXTURE.state.tasks[0], FIXTURE.state.tasks[0]] } },
      /duplicate task id/,
    ],
    [
      "an unsupported document version",
      { builds: { version: 99, builds: [] } },
      /unsupported document version 99/,
    ],
    ["a missing array", { builds: { version: 1 } }, /missing its "builds" array/],
    [
      "an unknown top-level field",
      { builds: { version: 1, builds: [], extra: 1 } },
      /unsupported field "extra"/,
    ],
  ];

  for (const [label, override, message] of cases) {
    it(`aborts the whole capture on ${label}`, async () => {
      const dir = await scratch();
      await writeSource(dir, override);
      await assert.rejects(captureJsonGroups(pathsIn(dir)), (error: unknown) => {
        assert.ok(error instanceof Error, "expected an Error");
        assert.match(error.message, message);
        return true;
      });
    });
  }

  it("aborts on malformed JSON instead of quarantining the file", async () => {
    const dir = await scratch();
    await writeSource(dir);
    await writeFile(pathsIn(dir).assets, "{ not json", "utf8");
    await assert.rejects(captureJsonGroups(pathsIn(dir)), StrictBackupError);
    // The forgiving store path renames a corrupt file aside; the strict reader must not.
    assert.equal(await exists(pathsIn(dir).assets), true);
  });

  it("refuses to follow a symlinked source", async () => {
    const dir = await scratch();
    const elsewhere = await scratch();
    await writeSource(elsewhere);
    await symlink(pathsIn(elsewhere).builds, pathsIn(dir).builds);
    await assert.rejects(readMemoryGroup(pathsIn(dir)), (error: unknown) => {
      assert.ok(error instanceof StrictBackupError);
      assert.match(error.message, /symbolic link/);
      return true;
    });
  });
});

describe("archive v4 — archive file integrity", () => {
  it("round-trips through a file and detects a tampered payload", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const file = path.join(dir, "archive.json");
    await writeArchiveV4File(file, archive);

    const reread = await readArchiveV4File(file);
    assert.deepEqual(reread, archive);
    assert.equal(reread.manifest.contractVersion, V4_CONTRACT_VERSION);
    assert.equal(((await stat(file)).mode & 0o777).toString(8), "600");

    const tampered = JSON.parse(await readFile(file, "utf8")) as ArchiveV4;
    tampered.groups.core!.tasks[0]!.title = "Order aluminium";
    assert.throws(
      () => parseArchiveV4(tampered),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /checksum mismatch/);
        return true;
      },
    );
  });

  it("rejects a manifest that lists a group the archive does not carry", async () => {
    const archive = await captureFixture();
    const stripped = { manifest: archive.manifest, groups: { core: archive.groups.core } };
    assert.throws(
      () => parseArchiveV4(stripped),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /carries no payload/);
        return true;
      },
    );
  });

  it("refuses to overwrite an existing archive file", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const file = path.join(dir, "archive.json");
    await writeArchiveV4File(file, archive);
    await assert.rejects(writeArchiveV4File(file, archive), (error: unknown) => {
      assert.ok(error instanceof StrictBackupError);
      assert.match(error.message, /already exists/);
      return true;
    });
  });
});

describe("archive v4 — a JSON-only archive is unmistakably partial", () => {
  it("marks the uncaptured groups absent and the archive partial", async () => {
    const { manifest } = await captureFixture();
    assert.equal(manifest.completeness, "partial");
    assert.deepEqual(manifest.coverage.present, ["core", "memory", "businessRecords"]);
    assert.deepEqual(manifest.coverage.absent, ABSENT_GROUPS);
    assert.deepEqual(manifest.coverage.required, [...ARCHIVE_GROUPS]);
    // Absence is not an exclusion: nothing here claims a recovery method.
    assert.deepEqual(manifest.exclusions, []);
  });

  it("is refused by the full-recovery path", async () => {
    const archive = await captureFixture();
    assert.throws(() => assertRecoverable(archive.manifest), ArchiveManifestError);
    const dir = await scratch();
    await assert.rejects(restoreArchiveV4(archive, path.join(dir, "restore")), (error: unknown) => {
      assert.ok(error instanceof ArchiveManifestError);
      assert.match(error.message, /Refusing full recovery from a partial archive/);
      return true;
    });
    assert.equal(await exists(path.join(dir, "restore")), false);
  });
});

describe("archive v4 — isolated restore", () => {
  it("materialises every record verbatim and both readers agree", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    const result = await restoreArchiveV4(archive, destination, { allowPartial: true });

    assert.equal(result.destination, destination);
    // verifyRestoredGroups already ran inside restoreArchiveV4; re-assert here so
    // the property is visible in the test rather than only inside the implementation.
    const core = await readCoreGroup(path.join(destination, "jarvis-state.json"));
    assert.deepEqual(core, archive.groups.core);
    const snapshot = await new JSONPersistence(
      path.join(destination, "jarvis-state.json"),
      () => {},
    ).snapshot();
    assert.deepEqual(snapshot.tasks, archive.groups.core?.tasks);
    assert.deepEqual(snapshot.reminders, archive.groups.core?.reminders);
    assert.deepEqual(snapshot.state, archive.groups.core?.state);
    assert.deepEqual(
      await new JsonBuildStore(path.join(destination, "jarvis-builds.json"), () => {}).list(),
      archive.groups.memory?.builds,
    );

    const marker = JSON.parse(await readFile(result.markerPath, "utf8")) as {
      completeness: string;
      absentGroups: string[];
    };
    assert.equal(marker.completeness, "partial");
    assert.deepEqual(marker.absentGroups, ABSENT_GROUPS);
    // The restored directory carries its own manifest, so it can never be
    // mistaken later for a complete recovery image.
    assert.deepEqual(
      JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8")),
      JSON.parse(JSON.stringify(archive.manifest)),
    );
  });

  it("refuses a destination that already exists", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await mkdir(destination);
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true }),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /was not written by a restore/);
        return true;
      },
    );
  });

  it("refuses a symlinked destination", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await symlink(await scratch(), destination);
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true }),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /symbolic link/);
        return true;
      },
    );
  });

  it("refuses a destination that overlaps the live data directory", async () => {
    const archive = await captureFixture();
    const live = await scratch();
    await assert.rejects(
      restoreArchiveV4(archive, path.join(live, "nested"), {
        allowPartial: true,
        liveDataDir: live,
      }),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /overlaps the live Jarvis data directory/);
        return true;
      },
    );
  });

  it("leaves an interrupted restore unmistakably incomplete, and a retry refuses it", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");

    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "upgrades" }),
      /Injected failure after writing upgrades/,
    );
    assert.equal(await exists(path.join(destination, "jarvis-upgrades.json")), true);
    assert.equal(await exists(path.join(destination, "jarvis-assets.json")), false);
    assert.equal(await exists(path.join(destination, "manifest.json")), false);
    assert.equal(await exists(path.join(destination, RESTORE_MARKER)), false);

    // The incomplete directory is not silently reused or repaired; recovery is
    // an explicit choice, and the refusal names it.
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true }),
      /interrupted restore of this archive[\s\S]*--resume/,
    );
  });
});

describe("archive v4 — CLI surface stays additive", () => {
  it("claims only the v4 subcommand names", () => {
    for (const command of ["export-v4", "verify-v4", "restore-v4"]) {
      assert.equal(isArchiveV4Command(command), true);
    }
    for (const command of ["export", "verify", "restore", ""]) {
      assert.equal(isArchiveV4Command(command), false);
    }
  });

  it("documents that this stage produces partial archives", () => {
    assert.match(archiveV4Usage().join("\n"), /partial/);
    assert.match(archiveV4Usage().join("\n"), /--allow-partial/);
  });
});

describe("archive v4 — references the source itself cannot resolve", () => {
  /**
   * Deleting a build does not cascade to its logs and upgrades, and nothing
   * enforces the dependency, so an orphaned row is a legal state of live data.
   * The capture must not refuse it and must not drop it.
   */
  const orphaned = {
    buildLogs: {
      version: 1,
      entries: [{ ...FIXTURE.buildLogs.entries[0], buildId: "build-deleted" }],
    },
    upgrades: {
      version: 1,
      entries: [{ ...FIXTURE.upgrades.entries[0], buildId: "build-deleted" }],
    },
  };

  it("captures the orphaned records and records the broken edges", async () => {
    const archive = await captureFixture(orphaned);
    assert.equal(archive.groups.memory?.buildLogs.length, 1);
    assert.equal(archive.groups.memory?.upgrades.length, 1);
    assert.deepEqual(archive.manifest.unresolvedReferences, [
      {
        group: "memory",
        collection: "buildLogs",
        recordId: "log-1",
        field: "buildId",
        value: "build-deleted",
        targetCollection: "builds",
      },
      {
        group: "memory",
        collection: "upgrades",
        recordId: "upg-1",
        field: "buildId",
        value: "build-deleted",
        targetCollection: "builds",
      },
    ]);
  });

  it("records none when every reference resolves", async () => {
    const archive = await captureFixture();
    assert.deepEqual(archive.manifest.unresolvedReferences, []);
  });

  it("carries the broken edges through restore without repairing them", async () => {
    const archive = await captureFixture(orphaned);
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await restoreArchiveV4(archive, destination, { allowPartial: true });
    const restored = await readMemoryGroup({
      builds: path.join(destination, "jarvis-builds.json"),
      buildLogs: path.join(destination, "jarvis-build-logs.json"),
      upgrades: path.join(destination, "jarvis-upgrades.json"),
      assets: path.join(destination, "jarvis-assets.json"),
      preferences: path.join(destination, "jarvis-preferences.json"),
    });
    assert.equal(restored.buildLogs[0]?.buildId, "build-deleted");
    const marker = JSON.parse(await readFile(path.join(destination, RESTORE_MARKER), "utf8")) as {
      unresolvedReferences: unknown[];
    };
    assert.equal(marker.unresolvedReferences.length, 2);
  });

  it("fails the restore when the manifest understates the broken edges it carries", async () => {
    const archive = await captureFixture(orphaned);
    const forged: ArchiveV4 = {
      manifest: { ...archive.manifest, unresolvedReferences: [] },
      groups: archive.groups,
    };
    const dir = await scratch();
    await assert.rejects(
      restoreArchiveV4(forged, path.join(dir, "restore"), { allowPartial: true }),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(
          error.message,
          /declares 0 unresolved reference\(s\), the restored data has 2/,
        );
        return true;
      },
    );
  });

  it("rejects an unresolved-reference entry naming an unknown group at parse time", async () => {
    const archive = await captureFixture(orphaned);
    const file = path.join(await scratch(), "archive.json");
    await writeArchiveV4File(file, archive);
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      manifest: { unresolvedReferences: Array<Record<string, unknown>> };
    };
    raw.manifest.unresolvedReferences[0]!.group = "notAGroup";
    assert.throws(
      () => parseArchiveV4(raw),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /must be one of/);
        return true;
      },
    );
  });
});

describe("archive v4 — completeness is earned by a real restore, not declared", () => {
  it("seals a capture with evidence re-derived from the restored documents", async () => {
    const archive = await captureFixture();
    assert.equal(archive.manifest.verification, null);
    assert.equal(archive.manifest.completeness, "partial");

    const result = await restoreArchiveV4(archive, path.join(await scratch(), "out"), {
      allowPartial: true,
    });
    const sealed = sealVerifiedArchive(archive, result.verifiedGroups, CREATED_AT);

    // The evidence is the digest of what came back off disk, and it matches the
    // captured group checksums — that is the whole claim.
    assert.deepEqual(sealed.manifest.verification?.groups.map((entry) => entry.group).sort(), [
      "businessRecords",
      "core",
      "memory",
    ]);
    for (const evidence of sealed.manifest.verification?.groups ?? []) {
      const carried = sealed.manifest.groups.find((entry) => entry.group === evidence.group);
      assert.equal(evidence.restoredChecksum, carried?.checksum);
    }
  });

  it("stays partial for the absent groups, not for want of verification", async () => {
    const archive = await captureFixture();
    const result = await restoreArchiveV4(archive, path.join(await scratch(), "out"), {
      allowPartial: true,
    });
    const sealed = sealVerifiedArchive(archive, result.verifiedGroups, CREATED_AT);

    assert.equal(sealed.manifest.completeness, "partial");
    assert.deepEqual([...sealed.manifest.coverage.absent].sort(), [...ABSENT_GROUPS].sort());
    assert.throws(
      () => {
        assertRecoverable(sealed.manifest);
      },
      (error: unknown) =>
        error instanceof Error &&
        /absent required group\(s\)/.test(error.message) &&
        !/never been verified/.test(error.message),
    );
  });

  it("survives the file round trip with its evidence intact", async () => {
    const archive = await captureFixture();
    const result = await restoreArchiveV4(archive, path.join(await scratch(), "out"), {
      allowPartial: true,
    });
    const sealed = sealVerifiedArchive(archive, result.verifiedGroups, CREATED_AT);

    const target = path.join(await scratch(), "sealed.json");
    await writeArchiveV4File(target, sealed);
    const readBack = await readArchiveV4File(target);
    assert.deepEqual(readBack.manifest.verification, sealed.manifest.verification);
    assert.equal(readBack.manifest.completeness, "partial");
  });

  it("refuses an archive whose evidence was edited to claim a different restore", async () => {
    const archive = await captureFixture();
    const result = await restoreArchiveV4(archive, path.join(await scratch(), "out"), {
      allowPartial: true,
    });
    const sealed = sealVerifiedArchive(archive, result.verifiedGroups, CREATED_AT);
    const tampered = JSON.parse(JSON.stringify(sealed)) as {
      manifest: { verification: { groups: { restoredChecksum: string }[] } };
    };
    tampered.manifest.verification.groups[0].restoredChecksum = `sha256:${"0".repeat(64)}`;

    assert.throws(
      () => parseArchiveV4(tampered),
      (error: unknown) =>
        error instanceof StrictBackupError &&
        /restored data is not what was captured/.test(error.message),
    );
  });
});
