import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { getFunctionName, type FunctionReference } from "convex/server";

import { sha256HexBytes } from "../src/actions/sha256.js";
import { defaultBusinessSettings } from "../src/businessSettings/businessSettings.js";
import {
  LOCAL_V1_ARCHIVE_FILE,
  LOCAL_V1_BLOB_DIR,
  LOCAL_V1_RECEIPTS_FILE,
  LOCAL_V1_S6_FILE,
  LocalV1CaptureError,
  captureLocalV1Archive,
  type LocalV1Client,
  type LocalV1ConvexMaterial,
} from "../src/backup/v4/localV1Capture.js";
import {
  LOCAL_V1_RECEIPT_CAPTURE_VERSION,
  LOCAL_V1_RECEIPT_TABLES,
} from "../src/backup/v4/localV1Receipts.js";
import { readArchiveV4File } from "../src/backup/v4/archive.js";
import type { BusinessPaths } from "../src/backup/v4/businessSource.js";
import { S6_CAPTURE_VERSION, S6_TABLES } from "../src/backup/v4/s6MutableQuotes.js";
import { JARVIS_DATA_DIR } from "../src/persistence/jarvisDataPaths.js";

const SERVICE = "lv1-capture-service-token-000000000000";
const APPROVAL = "lv1-capture-approval-token-00000000000";
const ENDPOINT = "https://lv1-09-capture.invalid";
const AT = new Date("2026-10-07T03:00:00.000Z");
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const PDF_HEX = sha256HexBytes(PDF);

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-lv1-capture-"));
  roots.push(dir);
  return dir;
}

function businessPaths(dir: string): BusinessPaths {
  return {
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

const CLIENT = {
  id: "client-1",
  name: "Marlow & Sons",
  contacts: [{ label: "office", value: "03 9000 0000" }],
  notes: "Prefers morning calls",
  createdAt: 1_700_000_000_001,
  updatedAt: 1_700_000_000_002,
};
const PROPERTY = {
  id: "property-1",
  clientId: "client-1",
  address: "12 Wattle Street, Frankston",
  hazards: ["asbestos eaves"],
  accessNotes: "Key safe",
  createdAt: 1_700_000_100_001,
  updatedAt: 1_700_000_100_002,
};
const PROJECT = {
  id: "project-1",
  clientId: "client-1",
  propertyId: "property-1",
  title: "Re-roof rear extension",
  status: "active",
  notes: "Two-stage handover",
  scheduledFor: "2026-11-02",
  createdAt: 1_700_000_200_001,
  updatedAt: 1_700_000_200_002,
};
const QUOTE = {
  id: "quote-1",
  clientId: "client-1",
  projectId: "project-1",
  number: "BTQ-0001",
  status: "accepted",
  lineItems: [{ description: "Labour", quantity: 1, unitPrice: 95 }],
  subtotal: 95,
  taxRate: 0.1,
  tax: 9.5,
  total: 104.5,
  validUntil: "2026-10-01",
  createdAt: 1_700_000_300_001,
  updatedAt: 1_700_000_300_002,
};
const INVOICE = {
  id: "invoice-1",
  clientId: "client-1",
  projectId: "project-1",
  quoteId: "quote-1",
  number: "BTI-0001",
  status: "issued",
  lineItems: [{ description: "Stage one", quantity: 1, unitPrice: 95 }],
  subtotal: 95,
  taxRate: 0.1,
  tax: 9.5,
  total: 104.5,
  amountPaid: 0,
  balanceDue: 104.5,
  paymentStatus: "unpaid",
  dueDate: "2026-09-30",
  payments: [],
  issuedAt: 1_700_000_350_000,
  createdAt: 1_700_000_340_001,
  updatedAt: 1_700_000_400_002,
};
const ENQUIRY = {
  id: "enquiry-1",
  clientId: "client-1",
  propertyId: "property-1",
  source: "phone",
  requestedWork: "Roof leak",
  urgency: "urgent",
  preferredDateText: "next week",
  attachmentRefs: ["photo-1"],
  siteNotes: "Rear access",
  status: "converted",
  convertedProjectId: "project-1",
  createdAt: 1_700_000_050_001,
  updatedAt: 1_700_000_200_003,
};
const ERRAND = {
  id: "errand-1",
  title: "Roofing screws",
  quantity: 2,
  status: "open",
  location: { label: "Bunnings", address: "111 Cranbourne Road", lat: -38.15, lon: 145.13 },
  projectId: "project-1",
  createdAt: 1_700_000_500_001,
  updatedAt: 1_700_000_500_002,
};
const SETTINGS = {
  ...defaultBusinessSettings(1_600_000_000_000),
  businessName: "THE BEEZ TREEZ PROPERTY SOLUTIONS",
  updatedAt: 1_700_000_600_000,
};

async function writeBusiness(dir: string): Promise<void> {
  const paths = businessPaths(dir);
  const documents: Record<keyof BusinessPaths, unknown> = {
    clients: { version: 1, clients: [CLIENT] },
    properties: { version: 1, properties: [PROPERTY] },
    projects: { version: 1, projects: [PROJECT] },
    quotes: { version: 1, quotes: [QUOTE] },
    invoices: { version: 1, invoices: [INVOICE] },
    enquiries: { version: 1, enquiries: [ENQUIRY] },
    errands: { version: 1, errands: [ERRAND] },
    businessSettings: { version: 1, settings: SETTINGS },
  };
  for (const [key, filePath] of Object.entries(paths)) {
    await writeFile(filePath, `${JSON.stringify(documents[key as keyof BusinessPaths])}\n`);
  }
  await writeFile(
    path.join(dir, "jarvis-state.json"),
    `${JSON.stringify({ version: 2, state: {}, tasks: [{ id: "stale", title: "STALE", completed: false, category: "home", createdAt: 1 }], reminders: [] })}\n`,
  );
}

function encoded(body: unknown): { payloadJson: string; payloadSha256: string } {
  const payloadJson = JSON.stringify(body);
  return { payloadJson, payloadSha256: sha256HexBytes(new TextEncoder().encode(payloadJson)) };
}

function material(args: {
  businessChecksum: string;
  capturedAt: number;
  omit?: "s6" | "receipts" | "pdf";
}): LocalV1ConvexMaterial {
  const artifact = [
    {
      _id: "artifact-1",
      storageId: "storage-1",
      digest: `quote-pdf:v1:sha256:${PDF_HEX}`,
      byteLength: PDF.byteLength,
    },
  ];
  const s6Tables = S6_TABLES.map((table) => ({
    table,
    documents:
      table === "quotes"
        ? [{ _id: "quote-row", quoteId: "cq-1", clientId: "client-1" }]
        : table === "quoteRevisions"
          ? [{ _id: "revision-row", quoteId: "cq-1", revisionId: "rev-1" }]
          : table === "quotePdfArtifacts"
            ? artifact
            : table === "quoteDeliveryAttempts"
              ? [{ _id: "delivery-1" }]
              : table === "quoteMigrationRecords"
                ? [{ _id: "migration-1" }]
                : table === "toolActions"
                  ? [{ _id: "action-1" }]
                  : table === "toolExecutionReceipts"
                    ? [{ _id: "tool-receipt-1" }]
                    : [{ _id: "reconciliation-1" }],
  }));
  if (args.omit === "s6") s6Tables.pop();
  const receiptTables = LOCAL_V1_RECEIPT_TABLES.map((table) => ({
    table,
    documents:
      table === "directCreateReceipts"
        ? [{ _id: "direct-1", entityId: "task-1" }]
        : [{ _id: "internal-1", entityId: "task-1" }],
  }));
  if (args.omit === "receipts") receiptTables.pop();
  const s6 = {
    ...encoded({
      version: S6_CAPTURE_VERSION,
      provider: "convex",
      ownerId: "jarvis-cli",
      capturedAt: args.capturedAt,
      businessChecksum: args.businessChecksum,
      tables: s6Tables,
    }),
    restoreVerified: false as const,
  };
  const receipts = encoded({
    version: LOCAL_V1_RECEIPT_CAPTURE_VERSION,
    provider: "convex",
    ownerId: "jarvis-cli",
    capturedAt: args.capturedAt,
    tables: receiptTables,
  });
  return { s6, receipts };
}

function pdfBlobs(omit: "s6" | "receipts" | "pdf" | undefined) {
  if (omit === "pdf") return [];
  const bytes = PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.byteLength) as ArrayBuffer;
  return [
    {
      reference: "quotePdfArtifacts/artifact-1",
      digest: `sha256:${PDF_HEX}`,
      byteLength: PDF.byteLength,
      bytes,
    },
  ];
}

function scriptedClient(options?: { fail?: boolean; omit?: "s6" | "receipts" | "pdf" }): {
  client: LocalV1Client;
  calls: string[];
  mutations: { count: number };
} {
  const calls: string[] = [];
  const mutations = { count: 0 };
  const client = {
    query: async (ref: FunctionReference<"query">, args: Record<string, unknown>) => {
      const name = getFunctionName(ref);
      calls.push(name);
      if (options?.fail === true && name === "backupS6:captureLocalV1") {
        throw new Error("convex source failed");
      }
      if (name === "assistantState:snapshot") {
        return {
          state: { note: "live-state" },
          tasks: [
            {
              _id: "task-1",
              title: "live-task",
              completed: false,
              category: "home",
              createdAt: 1,
            },
          ],
          reminders: [{ _id: "reminder-1", title: "live-reminder", createdAt: 2 }],
        };
      }
      if (name === "builds:list") {
        return [
          {
            _id: "build-1",
            name: "live-build",
            kind: "boat",
            status: "active",
            createdAt: 3,
            updatedAt: 4,
          },
        ];
      }
      if (name === "buildLogs:list") {
        return [
          { _id: "log-1", buildId: "build-1", kind: "note", title: "live-log", createdAt: 5 },
        ];
      }
      if (name === "upgrades:list") {
        return [{ _id: "upgrade-1", buildId: "build-1", title: "live-upgrade", createdAt: 6 }];
      }
      if (name === "assets:list") {
        return [{ _id: "asset-1", name: "live-asset", kind: "tool", createdAt: 7, updatedAt: 8 }];
      }
      if (name === "preferences:list") {
        return [{ _id: "pref-1", key: "live-pref", value: "yes", createdAt: 9, updatedAt: 10 }];
      }
      if (name === "backupS6:captureLocalV1") {
        return material({
          businessChecksum: String(args.businessChecksum),
          capturedAt: Number(args.capturedAt),
          ...(options?.omit === undefined ? {} : { omit: options.omit }),
        });
      }
      throw new Error(`unexpected query ${name}`);
    },
    action: async (ref: FunctionReference<"action">) => {
      const name = getFunctionName(ref);
      calls.push(name);
      if (options?.fail === true && name === "backupS6:readLocalV1Blobs") {
        throw new Error("convex source failed");
      }
      if (name !== "backupS6:readLocalV1Blobs") throw new Error(`unexpected action ${name}`);
      return pdfBlobs(options?.omit);
    },
    mutation: async () => {
      mutations.count += 1;
      return null;
    },
  } as LocalV1Client;
  return { client, calls, mutations };
}

async function digestTree(dir: string): Promise<Map<string, string>> {
  const names = (await readdir(dir)).sort();
  const digests = new Map<string, string>();
  for (const name of names) {
    digests.set(
      name,
      createHash("sha256")
        .update(await readFile(path.join(dir, name)))
        .digest("hex"),
    );
  }
  return digests;
}

describe("Local V1 partial capture", () => {
  it("captures every live store and leaves completeness partial", async () => {
    const root = await scratch();
    const live = path.join(root, "live");
    await writeFile(path.join(root, ".keep"), "");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(live);
    await writeBusiness(live);
    const before = await digestTree(live);
    const scripted = scriptedClient();
    const captured = await captureLocalV1Archive({
      outputDirectory: path.join(root, "out"),
      businessPaths: businessPaths(live),
      client: scripted.client,
      serviceToken: SERVICE,
      approvalToken: APPROVAL,
      convexUrl: ENDPOINT,
      capturedAt: AT,
    });
    assert.deepEqual(await digestTree(live), before);
    assert.equal(scripted.mutations.count, 0);
    assert.equal(scripted.calls.includes("backupS6:captureLocalV1"), true);
    assert.equal(
      scripted.calls.some((name) => name.startsWith("assistantState:")),
      true,
    );
    const archive = await readArchiveV4File(captured.archivePath);
    assert.equal(archive.manifest.completeness, "partial");
    assert.deepEqual(archive.manifest.coverage.absent, [
      "notesAndEvidence",
      "orchestration",
      "quoteAggregate",
    ]);
    assert.equal(
      archive.manifest.groups.every((group) => group.consistentSnapshot === false),
      true,
    );
    assert.equal(archive.groups.core?.tasks[0]?.title, "live-task");
    assert.equal(archive.groups.core?.reminders[0]?.title, "live-reminder");
    assert.equal(archive.groups.core?.state.note, "live-state");
    assert.equal(archive.groups.memory?.builds[0]?.name, "live-build");
    assert.equal(archive.groups.memory?.buildLogs[0]?.title, "live-log");
    assert.equal(archive.groups.memory?.upgrades[0]?.title, "live-upgrade");
    assert.equal(archive.groups.memory?.assets[0]?.name, "live-asset");
    assert.equal(archive.groups.memory?.preferences[0]?.key, "live-pref");
    assert.equal(JSON.stringify(archive).includes("STALE"), false);
    const business = archive.groups.businessRecords;
    assert.equal(business?.clients[0]?.id, "client-1");
    assert.equal(business?.properties[0]?.id, "property-1");
    assert.equal(business?.projects[0]?.id, "project-1");
    assert.equal(business?.quotes[0]?.id, "quote-1");
    assert.equal(business?.invoices[0]?.id, "invoice-1");
    assert.equal(business?.enquiries[0]?.id, "enquiry-1");
    assert.equal(business?.errands[0]?.id, "errand-1");
    assert.equal(business?.businessSettings?.businessName, SETTINGS.businessName);
    const s6 = JSON.parse(
      await readFile(path.join(captured.outputDirectory, LOCAL_V1_S6_FILE), "utf8"),
    ) as {
      payloadJson: string;
    };
    const s6Body = JSON.parse(s6.payloadJson) as {
      tables: Array<{ table: string; documents: unknown[] }>;
    };
    assert.deepEqual(
      s6Body.tables.map((table) => table.table),
      [...S6_TABLES],
    );
    assert.equal(
      s6Body.tables.every((table) => table.documents.length === 1),
      true,
    );
    const receipts = JSON.parse(
      await readFile(path.join(captured.outputDirectory, LOCAL_V1_RECEIPTS_FILE), "utf8"),
    ) as { payloadJson: string };
    const receiptBody = JSON.parse(receipts.payloadJson) as {
      tables: Array<{ table: string; documents: unknown[] }>;
    };
    assert.deepEqual(
      receiptBody.tables.map((table) => table.table),
      [...LOCAL_V1_RECEIPT_TABLES],
    );
    assert.deepEqual(archive.manifest.blobs, [
      {
        reference: "quotePdfArtifacts/artifact-1",
        digest: `sha256:${PDF_HEX}`,
        byteLength: PDF.byteLength,
      },
    ]);
    const blob = await readFile(path.join(captured.outputDirectory, LOCAL_V1_BLOB_DIR, PDF_HEX));
    assert.deepEqual(blob, Buffer.from(PDF));
    const names = await readdir(captured.outputDirectory);
    assert.deepEqual(
      names.sort(),
      [LOCAL_V1_ARCHIVE_FILE, LOCAL_V1_BLOB_DIR, LOCAL_V1_RECEIPTS_FILE, LOCAL_V1_S6_FILE].sort(),
    );
  });

  it("fails closed when a source is missing or the query fails, and writes nothing", async () => {
    const root = await scratch();
    const live = path.join(root, "live");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(live);
    await writeBusiness(live);
    const before = await digestTree(live);
    const output = path.join(root, "out");
    const corrupt = scriptedClient();
    await writeFile(businessPaths(live).clients, "{");
    await assert.rejects(
      () =>
        captureLocalV1Archive({
          outputDirectory: output,
          businessPaths: businessPaths(live),
          client: corrupt.client,
          serviceToken: SERVICE,
          approvalToken: APPROVAL,
          convexUrl: ENDPOINT,
          capturedAt: AT,
        }),
      /not valid JSON/,
    );
    assert.equal(corrupt.calls.length, 0);
    await assert.rejects(readdir(output), { code: "ENOENT" });
    assert.equal(await readFile(businessPaths(live).clients, "utf8"), "{");
    const names = await readdir(live);
    assert.equal(
      names.some((name) => name.includes(".corrupt-")),
      false,
    );
    await writeBusiness(live);
    for (const omit of ["s6", "receipts", "pdf"] as const) {
      const scripted = scriptedClient({ omit });
      await assert.rejects(
        () =>
          captureLocalV1Archive({
            outputDirectory: output,
            businessPaths: businessPaths(live),
            client: scripted.client,
            serviceToken: SERVICE,
            approvalToken: APPROVAL,
            convexUrl: ENDPOINT,
            capturedAt: AT,
          }),
        (error: unknown) => error instanceof LocalV1CaptureError,
      );
      await assert.rejects(readdir(output), { code: "ENOENT" });
    }
    const failed = scriptedClient({ fail: true });
    await assert.rejects(
      () =>
        captureLocalV1Archive({
          outputDirectory: output,
          businessPaths: businessPaths(live),
          client: failed.client,
          serviceToken: SERVICE,
          approvalToken: APPROVAL,
          convexUrl: ENDPOINT,
          capturedAt: AT,
        }),
      /convex source failed/,
    );
    await assert.rejects(readdir(output), { code: "ENOENT" });
    assert.deepEqual(await digestTree(live), before);
  });

  it("refuses a live URL and an output directory inside live data, and does not query", async () => {
    const root = await scratch();
    const live = path.join(root, "live");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(live);
    await writeBusiness(live);
    const before = await digestTree(live);
    const previous = process.env.CONVEX_URL;
    process.env.CONVEX_URL = "https://live.example";
    try {
      const scripted = scriptedClient();
      await assert.rejects(
        () =>
          captureLocalV1Archive({
            outputDirectory: path.join(root, "out"),
            businessPaths: businessPaths(live),
            client: scripted.client,
            serviceToken: SERVICE,
            approvalToken: APPROVAL,
            convexUrl: "https://live.example",
            capturedAt: AT,
          }),
        /CONVEX_URL/,
      );
      assert.equal(scripted.calls.length, 0);
      assert.equal(scripted.mutations.count, 0);
      const nested = scriptedClient();
      await assert.rejects(
        () =>
          captureLocalV1Archive({
            outputDirectory: path.join(live, "out"),
            businessPaths: businessPaths(live),
            client: nested.client,
            serviceToken: SERVICE,
            approvalToken: APPROVAL,
            convexUrl: ENDPOINT,
            capturedAt: AT,
          }),
        /overlaps a live data path/,
      );
      assert.equal(nested.calls.length, 0);
      await assert.rejects(readdir(path.join(live, "out")), { code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.CONVEX_URL;
      else process.env.CONVEX_URL = previous;
    }
    assert.deepEqual(await digestTree(live), before);
  });

  it("refuses an output path whose parent symlink points at a business directory", async () => {
    const root = await scratch();
    const business = path.join(root, "business");
    const { mkdir, symlink } = await import("node:fs/promises");
    await mkdir(business);
    await writeBusiness(business);
    const before = await digestTree(business);
    const alias = path.join(root, "business-alias");
    await symlink(business, alias);
    const scripted = scriptedClient();
    await assert.rejects(
      () =>
        captureLocalV1Archive({
          outputDirectory: path.join(alias, "out"),
          businessPaths: businessPaths(business),
          client: scripted.client,
          serviceToken: SERVICE,
          approvalToken: APPROVAL,
          convexUrl: ENDPOINT,
          capturedAt: AT,
        }),
      /overlaps a live data path/,
    );
    assert.equal(scripted.calls.length, 0);
    assert.equal(scripted.mutations.count, 0);
    await assert.rejects(readdir(path.join(business, "out")), { code: "ENOENT" });
    assert.deepEqual(await digestTree(business), before);
  });

  it("refuses an output path whose parent symlink points at the data directory", async () => {
    const root = await scratch();
    const business = path.join(root, "business");
    const { mkdir, symlink } = await import("node:fs/promises");
    await mkdir(business);
    await writeBusiness(business);
    const before = await digestTree(business);
    await mkdir(JARVIS_DATA_DIR, { recursive: true });
    const probe = `lv1-capture-probe-${randomBytes(8).toString("hex")}`;
    const landed = path.join(JARVIS_DATA_DIR, probe);
    await assert.rejects(readdir(landed), { code: "ENOENT" });
    const alias = path.join(root, "data-alias");
    await symlink(JARVIS_DATA_DIR, alias);
    const scripted = scriptedClient();
    try {
      await assert.rejects(
        () =>
          captureLocalV1Archive({
            outputDirectory: path.join(alias, probe),
            businessPaths: businessPaths(business),
            client: scripted.client,
            serviceToken: SERVICE,
            approvalToken: APPROVAL,
            convexUrl: ENDPOINT,
            capturedAt: AT,
          }),
        /overlaps a live data path/,
      );
      assert.equal(scripted.calls.length, 0);
      assert.equal(scripted.mutations.count, 0);
      await assert.rejects(readdir(landed), { code: "ENOENT" });
    } finally {
      await rm(landed, { recursive: true, force: true });
    }
    assert.deepEqual(await digestTree(business), before);
  });
});
