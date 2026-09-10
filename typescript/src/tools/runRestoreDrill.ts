import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildArchiveV4, type ArchiveV4 } from "../backup/v4/archive.js";
import { captureJsonGroups, type CapturePaths } from "../backup/v4/jsonSource.js";
import {
  RESTORE_IN_PROGRESS_MARKER,
  RESTORE_MARKER,
  inspectDestination,
  restoreArchiveV4,
} from "../backup/v4/restore.js";
import { defaultBusinessSettings } from "../businessSettings/businessSettings.js";

/**
 * Recoverable-restore drill.
 *
 * Runs the interrupted-restore matrix end to end in a throwaway directory and
 * prints a recorded result table, so the property can be re-established on
 * another machine without reading the test suite.
 *
 * It is deliberately self-contained: it builds its own source dataset, captures
 * its own archive and restores into its own scratch directory. It never reads
 * the live Jarvis data directory, never writes outside the scratch directory it
 * creates, and performs no external effect of any kind — so it is safe to run in
 * any clean development environment.
 */

type DrillRow = {
  interruptedAfter: string;
  leftIncomplete: boolean;
  retryRefused: boolean;
  resumeCompleted: boolean;
  identicalToUninterrupted: boolean;
};

const SOURCE: Record<keyof CapturePaths, unknown> = {
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

const CREATED_AT = new Date("2026-09-10T12:00:00.000Z");

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

async function contentsOf(dir: string): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const entry of (await readdir(dir)).sort()) {
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

async function expectRejection(operation: Promise<unknown>, pattern: RegExp): Promise<boolean> {
  try {
    await operation;
    return false;
  } catch (error: unknown) {
    return error instanceof Error && pattern.test(error.message);
  }
}

async function runOne(
  root: string,
  archive: ArchiveV4,
  point: keyof CapturePaths,
  reference: Record<string, string>,
): Promise<DrillRow> {
  const destination = path.join(root, `interrupt-after-${point}`);

  const injected = await expectRejection(
    restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: point }),
    new RegExp(`Injected failure after writing ${point}`),
  );
  const leftIncomplete =
    injected &&
    !(await exists(path.join(destination, RESTORE_MARKER))) &&
    (await exists(path.join(destination, RESTORE_IN_PROGRESS_MARKER))) &&
    (await inspectDestination(destination)).kind === "interrupted";

  const retryRefused = await expectRejection(
    restoreArchiveV4(archive, destination, { allowPartial: true }),
    /interrupted restore of this archive[\s\S]*--resume/,
  );

  let resumeCompleted: boolean;
  try {
    resumeCompleted = (
      await restoreArchiveV4(archive, destination, {
        allowPartial: true,
        resume: true,
        now: () => CREATED_AT,
      })
    ).resumed;
  } catch {
    resumeCompleted = false;
  }

  const recovered = await contentsOf(destination);
  const expected = { ...reference };
  delete recovered[RESTORE_MARKER];
  delete expected[RESTORE_MARKER];

  return {
    interruptedAfter: point,
    leftIncomplete,
    retryRefused,
    resumeCompleted,
    identicalToUninterrupted: JSON.stringify(recovered) === JSON.stringify(expected),
  };
}

function renderTable(rows: readonly DrillRow[]): string {
  const tick = (value: boolean): string => (value ? "pass" : "FAIL");
  const header = [
    "| Interrupted after | Left incomplete | Retry refused | Resume completed | Identical to uninterrupted |",
    "| --- | --- | --- | --- | --- |",
  ];
  const body = rows.map(
    (row) =>
      `| ${row.interruptedAfter} | ${tick(row.leftIncomplete)} | ${tick(row.retryRefused)} | ${tick(
        row.resumeCompleted,
      )} | ${tick(row.identicalToUninterrupted)} |`,
  );
  return [...header, ...body].join("\n");
}

async function runRestoreDrill(): Promise<{ rows: DrillRow[]; sourceUnchanged: boolean }> {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-restore-drill-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    const paths = pathsIn(source);
    for (const [key, target] of Object.entries(paths)) {
      await writeFile(
        target,
        `${JSON.stringify(SOURCE[key as keyof CapturePaths], null, 2)}\n`,
        "utf8",
      );
    }

    const archive = buildArchiveV4(await captureJsonGroups(paths), CREATED_AT);
    const sourceBefore = await contentsOf(source);

    const referenceDir = path.join(root, "reference");
    await restoreArchiveV4(archive, referenceDir, { allowPartial: true, now: () => CREATED_AT });
    const reference = await contentsOf(referenceDir);

    const points = Object.keys(paths) as Array<keyof CapturePaths>;
    const rows: DrillRow[] = [];
    for (const point of points) {
      rows.push(await runOne(root, archive, point, reference));
    }

    return {
      rows,
      sourceUnchanged: JSON.stringify(await contentsOf(source)) === JSON.stringify(sourceBefore),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { rows, sourceUnchanged } = await runRestoreDrill();
  console.log("# Archive v4 recoverable-restore drill\n");
  console.log(renderTable(rows));
  console.log("");
  console.log(`Source dataset unchanged by every restore: ${sourceUnchanged ? "pass" : "FAIL"}`);
  console.log(
    "No external effect is possible: the drill reads and writes only inside its own temporary directory.",
  );
  const failed =
    !sourceUnchanged ||
    rows.some(
      (row) =>
        !row.leftIncomplete ||
        !row.retryRefused ||
        !row.resumeCompleted ||
        !row.identicalToUninterrupted,
    );
  if (failed) {
    console.error("\nDrill FAILED: at least one property did not hold.");
    process.exitCode = 1;
    return;
  }
  console.log(`\nDrill passed for all ${String(rows.length)} interruption points.`);
}

main().catch((error: unknown) => {
  console.error("Restore drill failed to run:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
