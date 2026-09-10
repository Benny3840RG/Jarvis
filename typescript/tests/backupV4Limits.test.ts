import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { buildArchiveV4, readArchiveV4File, writeArchiveV4File } from "../src/backup/v4/archive.js";
import { captureJsonGroups, type CapturePaths } from "../src/backup/v4/jsonSource.js";
import {
  ARCHIVE_BYTES_ENV,
  DEFAULT_MAX_ARCHIVE_BYTES,
  MAX_MARKER_BYTES,
  resolveMaxArchiveBytes,
} from "../src/backup/v4/limits.js";
import {
  RESTORE_IN_PROGRESS_MARKER,
  inspectDestination,
  restoreArchiveV4,
} from "../src/backup/v4/restore.js";
import { readStrictDocument } from "../src/backup/v4/strictDocument.js";
import { StrictBackupError } from "../src/backup/strictValues.js";
import { defaultBusinessSettings } from "../src/businessSettings/businessSettings.js";

const CREATED_AT = new Date("2026-09-10T12:00:00.000Z");

const scratchRoots: string[] = [];

after(async () => {
  await Promise.all(scratchRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-v4-limits-"));
  scratchRoots.push(dir);
  return dir;
}

function pathsIn(dir: string): CapturePaths {
  const file = (name: string): string => path.join(dir, name);
  return {
    state: file("jarvis-state.json"),
    builds: file("jarvis-builds.json"),
    buildLogs: file("jarvis-build-logs.json"),
    upgrades: file("jarvis-upgrades.json"),
    assets: file("jarvis-assets.json"),
    preferences: file("jarvis-preferences.json"),
    clients: file("jarvis-clients.json"),
    properties: file("jarvis-properties.json"),
    projects: file("jarvis-projects.json"),
    quotes: file("jarvis-quotes.json"),
    invoices: file("jarvis-invoices.json"),
    enquiries: file("jarvis-enquiries.json"),
    errands: file("jarvis-errands.json"),
    businessSettings: file("jarvis-business-settings.json"),
  };
}

/** `invoiceCount` invoices, everything else empty. */
async function writeSource(dir: string, invoiceCount: number): Promise<CapturePaths> {
  const paths = pathsIn(dir);
  await writeFile(
    paths.state,
    JSON.stringify({ version: 2, state: {}, tasks: [], reminders: [] }),
    "utf8",
  );
  const arrays: Array<[keyof CapturePaths, string]> = [
    ["builds", "builds"],
    ["buildLogs", "entries"],
    ["upgrades", "entries"],
    ["assets", "entries"],
    ["preferences", "entries"],
    ["properties", "properties"],
    ["projects", "projects"],
    ["quotes", "quotes"],
    ["enquiries", "enquiries"],
    ["errands", "errands"],
  ];
  for (const [key, arrayKey] of arrays) {
    await writeFile(paths[key], JSON.stringify({ version: 1, [arrayKey]: [] }), "utf8");
  }
  await writeFile(
    paths.clients,
    JSON.stringify({
      version: 1,
      clients: [{ id: "client-1", name: "Marlow", contacts: [], createdAt: 1, updatedAt: 1 }],
    }),
    "utf8",
  );
  await writeFile(
    paths.invoices,
    JSON.stringify({
      version: 1,
      invoices: Array.from({ length: invoiceCount }, (_unused, index) => ({
        id: `invoice-${String(index)}`,
        clientId: "client-1",
        number: `BTI-${String(index)}`,
        status: "draft",
        lineItems: [
          {
            description: "Labour and materials for stage one of the works",
            quantity: 1,
            unitPrice: 100,
          },
        ],
        subtotal: 100,
        tax: 0,
        total: 100,
        amountPaid: 0,
        balanceDue: 100,
        paymentStatus: "unpaid",
        payments: [],
        createdAt: index,
        updatedAt: index,
      })),
    }),
    "utf8",
  );
  await writeFile(
    paths.businessSettings,
    JSON.stringify({ version: 1, settings: defaultBusinessSettings(1_600_000_000_000) }),
    "utf8",
  );
  return paths;
}

describe("archive v4 — the size bound is one number with an escape hatch", () => {
  it("defaults to 64 MiB and reads a valid override", () => {
    assert.equal(resolveMaxArchiveBytes({}), DEFAULT_MAX_ARCHIVE_BYTES);
    assert.equal(resolveMaxArchiveBytes({ [ARCHIVE_BYTES_ENV]: "" }), DEFAULT_MAX_ARCHIVE_BYTES);
    assert.equal(resolveMaxArchiveBytes({ [ARCHIVE_BYTES_ENV]: " 2097152 " }), 2_097_152);
  });

  it("refuses an override that is not a bounded whole number of bytes", () => {
    for (const value of ["-1", "1e9", "12.5", "lots", "1024", "9999999999999"]) {
      assert.throws(
        () => resolveMaxArchiveBytes({ [ARCHIVE_BYTES_ENV]: value }),
        new RegExp(ARCHIVE_BYTES_ENV),
        `expected ${value} to be refused`,
      );
    }
  });

  it("holds a few years of trading well inside the default", async () => {
    const dir = await scratch();
    const paths = await writeSource(dir, 4000);
    const archive = buildArchiveV4(await captureJsonGroups(paths), CREATED_AT);
    const target = path.join(await scratch(), "archive.json");
    await writeArchiveV4File(target, archive);
    const bytes = (await stat(target)).size;
    assert.ok(
      bytes < DEFAULT_MAX_ARCHIVE_BYTES / 4,
      `4000 invoices produced ${String(bytes)} bytes`,
    );
  });

  it("names the override when an archive would exceed the bound", async () => {
    const dir = await scratch();
    const paths = await writeSource(dir, 200);
    const archive = buildArchiveV4(await captureJsonGroups(paths), CREATED_AT);
    await assert.rejects(
      writeArchiveV4File(path.join(await scratch(), "archive.json"), archive, 4096),
      (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /Archive would be \d+ bytes/);
        assert.match(error.message, new RegExp(`raise it with ${ARCHIVE_BYTES_ENV}`));
        return true;
      },
    );
  });

  it("applies the same bound when reading an archive back", async () => {
    const dir = await scratch();
    const paths = await writeSource(dir, 200);
    const archive = buildArchiveV4(await captureJsonGroups(paths), CREATED_AT);
    const target = path.join(await scratch(), "archive.json");
    await writeArchiveV4File(target, archive);
    // An archive that can be written but not read back would be worse than
    // either limit alone, so the read uses the same number.
    await assert.rejects(readArchiveV4File(target, 4096), (error: unknown) => {
      assert.ok(error instanceof StrictBackupError);
      assert.match(error.message, new RegExp(`raise it with ${ARCHIVE_BYTES_ENV}`));
      return true;
    });
    await assert.doesNotReject(readArchiveV4File(target));
  });

  it("bounds a source file rather than reading it wholly into memory", async () => {
    const dir = await scratch();
    const target = path.join(dir, "jarvis-clients.json");
    const filler = "x".repeat(2 * 1024 * 1024);
    await writeFile(target, JSON.stringify({ version: 1, clients: [], filler }), "utf8");
    const previous = process.env[ARCHIVE_BYTES_ENV];
    process.env[ARCHIVE_BYTES_ENV] = String(1024 * 1024);
    try {
      await assert.rejects(readStrictDocument(target), (error: unknown) => {
        assert.ok(error instanceof StrictBackupError);
        assert.match(error.message, /Backup source .* is \d+ bytes/);
        assert.match(error.message, new RegExp(`raise it with ${ARCHIVE_BYTES_ENV}`));
        return true;
      });
    } finally {
      if (previous === undefined) delete process.env[ARCHIVE_BYTES_ENV];
      else process.env[ARCHIVE_BYTES_ENV] = previous;
    }
  });

  it("refuses to read an oversized restore marker", async () => {
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(destination);
    await writeFile(
      path.join(destination, RESTORE_IN_PROGRESS_MARKER),
      "x".repeat(MAX_MARKER_BYTES + 1),
      "utf8",
    );
    await assert.rejects(inspectDestination(destination), (error: unknown) => {
      assert.ok(error instanceof StrictBackupError);
      assert.match(error.message, /far larger than any marker this restore writes/);
      return true;
    });
  });
});

describe("archive v4 — a store that refuses a file says so as a backup failure", () => {
  it("names the file and the domain when the ordinary store will not load it", async () => {
    const dir = await scratch();
    const paths = await writeSource(dir, 1);
    // The settings store rejects credential-shaped text on load, which is a
    // correct refusal — but as a bare store error the operator cannot tell
    // which file stopped the backup.
    await writeFile(
      paths.businessSettings,
      JSON.stringify({
        version: 1,
        settings: {
          ...defaultBusinessSettings(1_600_000_000_000),
          paymentDetails: { paymentReferenceTemplate: "use api_key ABC as the reference" },
        },
      }),
      "utf8",
    );
    await assert.rejects(captureJsonGroups(paths), (error: unknown) => {
      assert.ok(error instanceof StrictBackupError, "expected a typed backup error");
      assert.match(error.message, /jarvis-business-settings\.json/);
      assert.match(error.message, /the ordinary businessSettings store refuses to load this file/);
      assert.match(error.message, /a restore would not be able to load it either/);
      return true;
    });
  });
});

describe("archive v4 — recovered data is not left world-readable", () => {
  it("writes the archive, the restored directory and its documents privately", async () => {
    const dir = await scratch();
    const paths = await writeSource(dir, 1);
    const archive = buildArchiveV4(await captureJsonGroups(paths), CREATED_AT);

    const target = path.join(await scratch(), "archive.json");
    await writeArchiveV4File(target, archive);
    assert.equal(((await stat(target)).mode & 0o777).toString(8), "600");

    const destination = path.join(await scratch(), "restore");
    await restoreArchiveV4(archive, destination, { allowPartial: true });
    assert.equal(((await stat(destination)).mode & 0o777).toString(8), "700");
    for (const name of ["jarvis-invoices.json", "jarvis-business-settings.json", "manifest.json"]) {
      assert.equal(
        ((await stat(path.join(destination, name))).mode & 0o777).toString(8),
        "600",
        `${name} must not be world-readable`,
      );
    }
    // Bank details really are in there; the file mode is what protects them.
    assert.match(
      await readFile(path.join(destination, "jarvis-business-settings.json"), "utf8"),
      /paymentDetails/,
    );
  });
});
