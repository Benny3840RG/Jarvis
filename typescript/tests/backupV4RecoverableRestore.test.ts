import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  symlink,
  rename,
  link,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { buildArchiveV4, type ArchiveV4 } from "../src/backup/v4/archive.js";
import { captureJsonGroups, type CapturePaths } from "../src/backup/v4/jsonSource.js";
import {
  RESTORE_IN_PROGRESS_MARKER,
  RESTORE_MARKER,
  archiveFingerprint,
  inspectDestination,
  restoreArchiveV4,
} from "../src/backup/v4/restore.js";
import { StrictBackupError } from "../src/backup/strictValues.js";
import { defaultBusinessSettings } from "../src/businessSettings/businessSettings.js";

const CREATED_AT = new Date("2026-09-10T12:00:00.000Z");

const scratchRoots: string[] = [];

after(async () => {
  await Promise.all(scratchRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-v4-recover-"));
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

/** One record in every domain, so an interruption after any file is meaningful. */
const SOURCE: Record<string, unknown> = {
  state: {
    version: 2,
    state: { mode: "workshop" },
    tasks: [
      {
        id: "task-1",
        title: "Order steel",
        completed: false,
        category: "work",
        createdAt: 1_700_000_000_001,
      },
    ],
    reminders: [{ id: "rem-1", title: "Renew insurance", createdAt: 1_500_000_000_004 }],
  },
  builds: {
    version: 1,
    builds: [
      {
        id: "build-1",
        name: "Van shelving",
        kind: "vehicle",
        status: "planning",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  },
  buildLogs: {
    version: 1,
    entries: [{ id: "log-1", buildId: "build-1", kind: "note", title: "Measured", createdAt: 3 }],
  },
  upgrades: {
    version: 1,
    entries: [{ id: "upg-1", buildId: "build-1", title: "Heavier uprights", createdAt: 4 }],
  },
  assets: {
    version: 1,
    entries: [{ id: "asset-1", name: "Transit", kind: "vehicle", createdAt: 5, updatedAt: 6 }],
  },
  preferences: {
    version: 1,
    entries: [{ id: "pref-1", key: "units", value: "metric", createdAt: 7, updatedAt: 8 }],
  },
  clients: {
    version: 1,
    clients: [{ id: "client-1", name: "Marlow", contacts: [], createdAt: 9, updatedAt: 10 }],
  },
  properties: {
    version: 1,
    properties: [
      {
        id: "property-1",
        clientId: "client-1",
        address: "12 Wattle Street",
        hazards: [],
        createdAt: 11,
        updatedAt: 12,
      },
    ],
  },
  projects: {
    version: 1,
    projects: [
      {
        id: "project-1",
        clientId: "client-1",
        propertyId: "property-1",
        title: "Re-roof",
        status: "active",
        createdAt: 13,
        updatedAt: 14,
      },
    ],
  },
  quotes: {
    version: 1,
    quotes: [
      {
        id: "quote-1",
        clientId: "client-1",
        projectId: "project-1",
        number: "BTQ-0001",
        status: "draft",
        lineItems: [{ description: "Labour", quantity: 2, unitPrice: 100 }],
        subtotal: 200,
        tax: 0,
        total: 200,
        createdAt: 15,
        updatedAt: 16,
      },
    ],
  },
  invoices: {
    version: 1,
    invoices: [
      {
        id: "invoice-1",
        clientId: "client-1",
        quoteId: "quote-1",
        number: "BTI-0001",
        status: "draft",
        lineItems: [{ description: "Stage one", quantity: 1, unitPrice: 100 }],
        subtotal: 100,
        tax: 0,
        total: 100,
        amountPaid: 0,
        balanceDue: 100,
        paymentStatus: "unpaid",
        payments: [],
        createdAt: 17,
        updatedAt: 18,
      },
    ],
  },
  enquiries: {
    version: 1,
    enquiries: [
      {
        id: "enquiry-1",
        clientId: "client-1",
        source: "phone",
        requestedWork: "Roof leak",
        urgency: "urgent",
        attachmentRefs: [],
        status: "open",
        createdAt: 19,
        updatedAt: 20,
      },
    ],
  },
  errands: {
    version: 1,
    errands: [
      {
        id: "errand-1",
        title: "Roofing screws",
        status: "open",
        projectId: "project-1",
        createdAt: 21,
        updatedAt: 22,
      },
    ],
  },
  businessSettings: { version: 1, settings: defaultBusinessSettings(1_600_000_000_000) },
};

/** Every file the restore writes, in the order it writes them. */
const RESTORE_ORDER = [
  "jarvis-state.json",
  "jarvis-builds.json",
  "jarvis-build-logs.json",
  "jarvis-upgrades.json",
  "jarvis-assets.json",
  "jarvis-preferences.json",
  "jarvis-clients.json",
  "jarvis-properties.json",
  "jarvis-projects.json",
  "jarvis-quotes.json",
  "jarvis-invoices.json",
  "jarvis-enquiries.json",
  "jarvis-errands.json",
  "jarvis-business-settings.json",
];

const INJECTION_POINTS = [
  "state",
  "builds",
  "buildLogs",
  "upgrades",
  "assets",
  "preferences",
  "clients",
  "properties",
  "projects",
  "quotes",
  "invoices",
  "enquiries",
  "errands",
  "businessSettings",
] as const;

async function captureFixture(): Promise<ArchiveV4> {
  const dir = await scratch();
  const paths = pathsIn(dir);
  for (const [key, target] of Object.entries(paths)) {
    await writeFile(target, `${JSON.stringify(SOURCE[key], null, 2)}\n`, "utf8");
  }
  return buildArchiveV4(await captureJsonGroups(paths), CREATED_AT);
}

async function contentsOf(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir);
  const contents: Record<string, string> = {};
  for (const entry of entries.sort()) {
    contents[entry] = await readFile(path.join(dir, entry), "utf8");
  }
  return contents;
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

describe("archive v4 restore — an interruption is recoverable, not just refused", () => {
  it("covers every file the restore writes", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await restoreArchiveV4(archive, destination, { allowPartial: true });
    const marker = JSON.parse(await readFile(path.join(destination, RESTORE_MARKER), "utf8")) as {
      files: string[];
    };
    assert.deepEqual(marker.files, RESTORE_ORDER);
    assert.deepEqual([...INJECTION_POINTS].length, RESTORE_ORDER.length);
  });

  for (const point of INJECTION_POINTS) {
    it(`recovers from a failure after writing ${point}`, async () => {
      const archive = await captureFixture();
      const dir = await scratch();
      const destination = path.join(dir, "restore");

      await assert.rejects(
        restoreArchiveV4(archive, destination, {
          allowPartial: true,
          injectAfterWrite: point,
        }),
        new RegExp(`Injected failure after writing ${point}`),
      );

      // Unmistakably incomplete: no completion marker, in-progress marker intact.
      assert.equal(await exists(path.join(destination, RESTORE_MARKER)), false);
      const inProgress = JSON.parse(
        await readFile(path.join(destination, RESTORE_IN_PROGRESS_MARKER), "utf8"),
      ) as { archiveFingerprint: string; plannedFiles: string[] };
      assert.equal(inProgress.archiveFingerprint, archiveFingerprint(archive));
      assert.deepEqual(inProgress.plannedFiles, RESTORE_ORDER);

      const state = await inspectDestination(destination);
      assert.equal(state.kind, "interrupted");

      // A plain retry refuses, and says how to recover.
      await assert.rejects(
        restoreArchiveV4(archive, destination, { allowPartial: true }),
        (error: unknown) => {
          assert.ok(error instanceof StrictBackupError);
          assert.match(error.message, /interrupted restore of this archive/);
          assert.match(error.message, /--resume/);
          return true;
        },
      );

      // Resume completes, and produces exactly what an uninterrupted restore does.
      const result = await restoreArchiveV4(archive, destination, {
        allowPartial: true,
        resume: true,
        now: () => CREATED_AT,
      });
      assert.equal(result.resumed, true);
      const completion = JSON.parse(await readFile(result.markerPath, "utf8")) as {
        files: string[];
      };
      assert.deepEqual(completion.files, RESTORE_ORDER);
      assert.equal(await exists(path.join(destination, RESTORE_IN_PROGRESS_MARKER)), false);

      const reference = path.join(await scratch(), "reference");
      await restoreArchiveV4(archive, reference, { allowPartial: true, now: () => CREATED_AT });
      const recovered = await contentsOf(destination);
      const expected = await contentsOf(reference);
      // The completion marker records whether the run was a resume; the
      // recovered data itself must be identical.
      delete recovered[RESTORE_MARKER];
      delete expected[RESTORE_MARKER];
      assert.deepEqual(recovered, expected);
      assert.equal(
        (
          JSON.parse(await readFile(path.join(destination, RESTORE_MARKER), "utf8")) as {
            resumed: boolean;
          }
        ).resumed,
        true,
      );
    });
  }

  it("recovers from a failure between verification and the completion marker", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterVerify: true }),
      /Injected failure after verification/,
    );
    // Every document is on disk and correct, yet the restore is still not
    // complete — which is the point of writing the marker last.
    assert.equal(await exists(path.join(destination, "jarvis-business-settings.json")), true);
    assert.equal(await exists(path.join(destination, RESTORE_MARKER)), false);
    assert.equal((await inspectDestination(destination)).kind, "interrupted");

    const result = await restoreArchiveV4(archive, destination, {
      allowPartial: true,
      resume: true,
    });
    assert.equal(result.resumed, true);
    const completion = JSON.parse(await readFile(result.markerPath, "utf8")) as { files: string[] };
    assert.deepEqual(completion.files, RESTORE_ORDER);
  });
});

describe("archive v4 restore — recovery never touches what it did not write", () => {
  for (const alteration of ["extra-file", "missing-file", "duplicate-file", "contract-version"]) {
    it(`refuses a changed recovery marker (${alteration}) without deleting any files`, async () => {
      const archive = await captureFixture();
      const dir = await scratch();
      const destination = path.join(dir, "restore");
      await assert.rejects(
        restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "state" }),
        /Injected failure/,
      );
      const markerPath = path.join(destination, RESTORE_IN_PROGRESS_MARKER);
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
        contractVersion: string;
        plannedFiles: string[];
      };
      if (alteration === "extra-file") {
        await writeFile(path.join(destination, "operator-notes.txt"), "do not delete", "utf8");
        marker.plannedFiles.push("operator-notes.txt");
      } else if (alteration === "missing-file") {
        marker.plannedFiles.pop();
      } else if (alteration === "duplicate-file") {
        marker.plannedFiles.push(marker.plannedFiles[0]!);
      } else {
        marker.contractVersion = "unexpected-contract";
      }
      await writeFile(markerPath, JSON.stringify(marker), "utf8");
      const before = await contentsOf(destination);
      await assert.rejects(
        restoreArchiveV4(archive, destination, { allowPartial: true, resume: true }),
        /recovery marker does not match the archive/,
      );
      assert.deepEqual(await contentsOf(destination), before);
    });
  }

  it("validates all entry types before opening any interrupted restore output", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "clients" }),
      /Injected failure/,
    );
    const markerPath = path.join(destination, RESTORE_IN_PROGRESS_MARKER);
    const markerBefore = await readFile(markerPath, "utf8");
    const statePath = path.join(destination, "jarvis-state.json");
    await rm(statePath);
    await mkdir(statePath);
    const namesBefore = (await readdir(destination)).sort();
    const filesBefore = new Map<string, string>();
    for (const name of namesBefore) {
      if (name !== "jarvis-state.json")
        filesBefore.set(name, await readFile(path.join(destination, name), "utf8"));
    }
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, resume: true }),
      /is not a regular file/,
    );
    assert.deepEqual((await readdir(destination)).sort(), namesBefore);
    assert.equal(await readFile(markerPath, "utf8"), markerBefore);
    for (const [name, content] of filesBefore) {
      assert.equal(await readFile(path.join(destination, name), "utf8"), content);
    }
    assert.equal((await stat(statePath)).isDirectory(), true);
  });

  it("refuses to resume a directory holding a file the restore did not write", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "clients" }),
      /Injected failure/,
    );
    await writeFile(path.join(destination, "operator-notes.txt"), "do not delete", "utf8");

    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, resume: true }),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(
          error.message,
          /1 file\(s\) this restore did not write \(operator-notes.txt\)/,
        );
        return true;
      },
    );
    assert.equal(
      await readFile(path.join(destination, "operator-notes.txt"), "utf8"),
      "do not delete",
    );
  });

  it("refuses to resume an interrupted restore of a different archive", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "state" }),
      /Injected failure/,
    );

    const other = await captureFixture();
    // A different capture time is enough to make it a different archive.
    const relabelled: ArchiveV4 = {
      manifest: { ...other.manifest, createdAt: "2026-01-01T00:00:00.000Z" },
      groups: other.groups,
    };
    assert.notEqual(archiveFingerprint(relabelled), archiveFingerprint(archive));
    await assert.rejects(
      restoreArchiveV4(relabelled, destination, { allowPartial: true, resume: true }),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /interrupted restore of a different archive/);
        return true;
      },
    );
  });

  it("refuses a completed restore rather than overwriting recovered data", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await restoreArchiveV4(archive, destination, { allowPartial: true });
    assert.equal((await inspectDestination(destination)).kind, "completed");
    for (const options of [{ allowPartial: true }, { allowPartial: true, resume: true }]) {
      await assert.rejects(restoreArchiveV4(archive, destination, options), (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /already holds a completed restore/);
        return true;
      });
    }
  });

  it("refuses a pre-existing directory it did not create, resume or not", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await mkdir(destination);
    await writeFile(path.join(destination, "somebody-elses.json"), "{}", "utf8");
    for (const options of [{ allowPartial: true }, { allowPartial: true, resume: true }]) {
      await assert.rejects(restoreArchiveV4(archive, destination, options), (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /was not written by a restore/);
        return true;
      });
    }
    assert.equal(await exists(path.join(destination, "somebody-elses.json")), true);
  });
});

describe("archive v4 restore — no effect outside the destination", () => {
  it("leaves the source directory byte-identical, interrupted or not", async () => {
    const dir = await scratch();
    const paths = pathsIn(dir);
    for (const [key, target] of Object.entries(paths)) {
      await writeFile(target, `${JSON.stringify(SOURCE[key], null, 2)}\n`, "utf8");
    }
    const archive = buildArchiveV4(await captureJsonGroups(paths), CREATED_AT);
    const before = await contentsOf(dir);

    const destination = path.join(await scratch(), "restore");
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "quotes" }),
      /Injected failure/,
    );
    await restoreArchiveV4(archive, destination, { allowPartial: true, resume: true });

    assert.deepEqual(await contentsOf(dir), before);
  });

  it("writes nothing into the destination's parent", async () => {
    const archive = await captureFixture();
    const parent = await scratch();
    await restoreArchiveV4(archive, path.join(parent, "restore"), { allowPartial: true });
    assert.deepEqual(await readdir(parent), ["restore"]);
  });
});

describe("archive v4 restore — physical isolation and unchanged resume output", () => {
  for (const aliasTarget of ["destination-parent", "live-directory"] as const) {
    it(`rejects physical live overlap through a symlinked ${aliasTarget}`, async () => {
      const archive = await captureFixture();
      const root = await scratch();
      const live = path.join(root, "live");
      const alias = path.join(root, "alias");
      await mkdir(live);
      await symlink(live, alias);
      const destination = path.join(aliasTarget === "destination-parent" ? alias : live, "restore");
      await assert.rejects(
        restoreArchiveV4(archive, destination, {
          allowPartial: true,
          liveDataDir: aliasTarget === "live-directory" ? alias : live,
        }),
        /overlaps the live|symbolic link/,
      );
      assert.deepEqual(await readdir(live), []);
    });
  }

  for (const changedFile of ["jarvis-state.json", "manifest.json"] as const) {
    it(`preserves every file when ${changedFile} was replaced after interruption`, async () => {
      const archive = await captureFixture();
      const root = await scratch();
      const destination = path.join(root, "restore");
      await assert.rejects(
        restoreArchiveV4(archive, destination, {
          allowPartial: true,
          injectAfterVerify: true,
        }),
        /Injected failure/,
      );
      const replacement = path.join(root, "replacement");
      await writeFile(
        replacement,
        changedFile === "jarvis-state.json"
          ? "X".repeat((await stat(path.join(destination, changedFile))).size)
          : "operator replacement; never remove",
      );
      await rename(replacement, path.join(destination, changedFile));
      const before = await contentsOf(destination);
      await assert.rejects(
        restoreArchiveV4(archive, destination, {
          allowPartial: true,
          resume: true,
        }),
        /does not match|changed|unmodified/,
      );
      assert.deepEqual(await contentsOf(destination), before);
    });
  }
});

it("retains exact matching output files when resuming missing writes", async () => {
  const archive = await captureFixture();
  const destination = path.join(await scratch(), "restore");
  await assert.rejects(
    restoreArchiveV4(archive, destination, {
      allowPartial: true,
      injectAfterWrite: "state",
    }),
    /Injected failure/,
  );
  const target = path.join(destination, "jarvis-state.json");
  const before = await stat(target);
  await restoreArchiveV4(archive, destination, { allowPartial: true, resume: true });
  const after = await stat(target);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

it("rejects a live descendant whose name merely starts with two dots", async () => {
  const archive = await captureFixture();
  const live = await scratch();
  await assert.rejects(
    restoreArchiveV4(archive, path.join(live, "..restore"), {
      allowPartial: true,
      liveDataDir: live,
    }),
    /overlaps the live/,
  );
  assert.deepEqual(await readdir(live), []);
});

it("refuses byte-identical hard-linked output without modifying either link", async () => {
  const archive = await captureFixture();
  const root = await scratch();
  const destination = path.join(root, "restore");
  await assert.rejects(
    restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "state" }),
    /Injected failure/,
  );
  const target = path.join(destination, "jarvis-state.json");
  const external = path.join(root, "external-state.json");
  await rename(target, external);
  await link(external, target);
  const before = await contentsOf(destination);
  const externalBytes = await readFile(external);
  await assert.rejects(
    restoreArchiveV4(archive, destination, { allowPartial: true, resume: true }),
    /multiple links/,
  );
  assert.deepEqual(await contentsOf(destination), before);
  assert.deepEqual(await readFile(external), externalBytes);
  assert.equal((await stat(target)).ino, (await stat(external)).ino);
});

it("refuses a same-byte output symlink before opening it and preserves external data", async () => {
  const archive = await captureFixture();
  const root = await scratch();
  const destination = path.join(root, "restore");
  await assert.rejects(
    restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "state" }),
    /Injected failure/,
  );
  const target = path.join(destination, "jarvis-state.json");
  const external = path.join(root, "external-state.json");
  await rename(target, external);
  await symlink(external, target);
  const before = await contentsOf(destination);
  const externalBytes = await readFile(external);
  // The existing Dirent check rejects links before the bounded O_NOFOLLOW read.
  await assert.rejects(
    restoreArchiveV4(archive, destination, { allowPartial: true, resume: true }),
    /is not a regular file/,
  );
  assert.deepEqual(await contentsOf(destination), before);
  assert.deepEqual(await readFile(external), externalBytes);
});

it("refuses a hard-linked in-progress marker without writing missing archive files", async () => {
  const archive = await captureFixture();
  const root = await scratch();
  const destination = path.join(root, "restore");
  await assert.rejects(
    restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "state" }),
    /Injected failure/,
  );
  const marker = path.join(destination, RESTORE_IN_PROGRESS_MARKER);
  const external = path.join(root, "external-marker.json");
  await link(marker, external);
  const before = await contentsOf(destination);
  const markerBytes = await readFile(external);
  await assert.rejects(
    restoreArchiveV4(archive, destination, { allowPartial: true, resume: true }),
    /multiple links/,
  );
  assert.deepEqual(await contentsOf(destination), before);
  assert.deepEqual(await readFile(external), markerBytes);
});

for (const filename of ["jarvis-state.json", "manifest.json", RESTORE_IN_PROGRESS_MARKER]) {
  it(`refuses non-private retained ${filename} without changing any output`, async () => {
    const archive = await captureFixture();
    const destination = path.join(await scratch(), "restore");
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterVerify: true }),
      /Injected failure/,
    );
    const target = path.join(destination, filename);
    await chmod(target, 0o644);
    const before = await contentsOf(destination);
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, resume: true }),
      /private.*permissions/,
    );
    assert.deepEqual(await contentsOf(destination), before);
    assert.equal((await stat(target)).mode & 0o777, 0o644);
  });
}
