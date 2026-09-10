import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { buildArchiveV4, type ArchiveV4 } from "../src/backup/v4/archive.js";
import {
  businessUnresolvedReferences,
  readBusinessGroup,
} from "../src/backup/v4/businessSource.js";
import {
  CAPTURE_LOCK_ORDER,
  captureJsonGroups,
  type CapturePaths,
} from "../src/backup/v4/jsonSource.js";
import { restoreArchiveV4 } from "../src/backup/v4/restore.js";
import { StrictBackupError } from "../src/backup/strictValues.js";
import { JsonClientStore } from "../src/clients/jsonClientStore.js";
import { JsonInvoiceStore } from "../src/invoices/jsonInvoiceStore.js";
import { JsonQuoteStore } from "../src/quotes/jsonQuoteStore.js";
import { JsonBusinessSettingsStore } from "../src/businessSettings/jsonBusinessSettingsStore.js";
import { defaultBusinessSettings } from "../src/businessSettings/businessSettings.js";

const CREATED_AT = new Date("2026-09-10T12:00:00.000Z");
const QUIET = (): void => {};

const scratchRoots: string[] = [];

after(async () => {
  await Promise.all(scratchRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-v4-business-"));
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
 * A connected business dataset: a client with a property, a project on that
 * property, a quote for the project, an invoice raised from the quote with a
 * part payment, an enquiry converted into the project, and an errand for it.
 * Totals are the values the stores actually derive, so the fixture is what a
 * real deployment would hold rather than a hand-rounded approximation.
 */
const CLIENT = {
  id: "client-1",
  name: "Marlow & Sons",
  contacts: [{ label: "office", value: "03 9000 0000" }, { value: "accounts@marlow.example" }],
  notes: "Prefers morning calls",
  createdAt: 1_700_000_000_001,
  updatedAt: 1_700_000_000_002,
};

const PROPERTY = {
  id: "property-1",
  clientId: "client-1",
  address: "12 Wattle Street, Frankston",
  hazards: ["asbestos eaves", "steep driveway"],
  accessNotes: "Key safe at side gate",
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
  createdAt: 1_700_000_200_001,
  updatedAt: 1_700_000_200_002,
};

const QUOTE = {
  id: "quote-1",
  clientId: "client-1",
  projectId: "project-1",
  number: "BTQ-0001",
  status: "accepted",
  lineItems: [
    { description: "Colorbond sheeting", quantity: 42, unitPrice: 38.5 },
    { description: "Labour", quantity: 16, unitPrice: 95 },
  ],
  subtotal: 3137,
  taxRate: 0.1,
  tax: 313.7,
  total: 3450.7,
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
  lineItems: [{ description: "Stage one", quantity: 1, unitPrice: 1725.35 }],
  subtotal: 1725.35,
  taxRate: 0.1,
  tax: 172.54,
  total: 1897.89,
  amountPaid: 500,
  balanceDue: 1397.89,
  paymentStatus: "partial",
  dueDate: "2026-09-30",
  payments: [
    {
      id: "payment-1",
      amount: 500,
      receivedAt: 1_700_000_400_000,
      method: "bank transfer",
      reference: "BTI-0001",
      createdAt: 1_700_000_400_001,
    },
  ],
  issuedAt: 1_700_000_350_000,
  createdAt: 1_700_000_340_001,
  updatedAt: 1_700_000_400_002,
};

const ENQUIRY = {
  id: "enquiry-1",
  clientId: "client-1",
  propertyId: "property-1",
  source: "phone",
  requestedWork: "Roof leak over the kitchen",
  urgency: "urgent",
  preferredDateText: "next week",
  attachmentRefs: ["photo-1", "photo-2"],
  siteNotes: "Ladder access from rear",
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
  location: {
    label: "Bunnings Frankston",
    address: "111 Cranbourne Road",
    lat: -38.15,
    lon: 145.13,
  },
  projectId: "project-1",
  createdAt: 1_700_000_500_001,
  updatedAt: 1_700_000_500_002,
};

const SETTINGS = {
  ...defaultBusinessSettings(1_600_000_000_000),
  businessName: "THE BEEZ TREEZ PROPERTY SOLUTIONS",
  contactDetails: { phone: "03 9000 1111", email: "hello@beeztreez.example" },
  numbering: {
    quotePrefix: "BTQ",
    nextQuoteNumber: 2,
    invoicePrefix: "BTI",
    nextInvoiceNumber: 2,
  },
  updatedAt: 1_700_000_600_000,
};

const FIXTURE: Record<string, unknown> = {
  state: { version: 2, state: {}, tasks: [], reminders: [] },
  builds: { version: 1, builds: [] },
  buildLogs: { version: 1, entries: [] },
  upgrades: { version: 1, entries: [] },
  assets: { version: 1, entries: [] },
  preferences: { version: 1, entries: [] },
  clients: { version: 1, clients: [CLIENT] },
  properties: { version: 1, properties: [PROPERTY] },
  projects: { version: 1, projects: [PROJECT] },
  quotes: { version: 1, quotes: [QUOTE] },
  invoices: { version: 1, invoices: [INVOICE] },
  enquiries: { version: 1, enquiries: [ENQUIRY] },
  errands: { version: 1, errands: [ERRAND] },
  businessSettings: { version: 1, settings: SETTINGS },
};

async function writeSource(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const paths = pathsIn(dir);
  const documents: Record<string, unknown> = { ...FIXTURE, ...overrides };
  for (const [key, target] of Object.entries(paths)) {
    const document = documents[key];
    if (document === null) continue; // null means "this file has never existed"
    await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}

async function captureFixture(overrides: Record<string, unknown> = {}): Promise<ArchiveV4> {
  const dir = await scratch();
  await writeSource(dir, overrides);
  return buildArchiveV4(await captureJsonGroups(pathsIn(dir)), CREATED_AT);
}

describe("archive v4 — business records capture", () => {
  it("preserves every domain, id and timestamp verbatim", async () => {
    const business = (await captureFixture()).groups.businessRecords;
    assert.ok(business);
    assert.deepEqual(business.clients, [CLIENT]);
    assert.deepEqual(business.properties, [PROPERTY]);
    assert.deepEqual(business.projects, [PROJECT]);
    assert.deepEqual(business.quotes, [QUOTE]);
    assert.deepEqual(business.invoices, [INVOICE]);
    assert.deepEqual(business.enquiries, [ENQUIRY]);
    assert.deepEqual(business.errands, [ERRAND]);
    assert.deepEqual(business.businessSettings, SETTINGS);
  });

  it("counts every domain in the manifest, settings included", async () => {
    const { manifest } = await captureFixture();
    const entry = manifest.groups.find((group) => group.group === "businessRecords");
    assert.deepEqual(entry?.counts, {
      clients: 1,
      properties: 1,
      projects: 1,
      quotes: 1,
      invoices: 1,
      enquiries: 1,
      errands: 1,
      businessSettings: 1,
    });
    assert.equal(entry?.consistentSnapshot, true);
  });

  it("locks the business files in the same fixed order, after the core files", () => {
    assert.deepEqual([...CAPTURE_LOCK_ORDER], Object.keys(pathsIn("/x")));
  });

  it("distinguishes settings never written from settings stored as defaults", async () => {
    const never = await captureFixture({ businessSettings: null });
    assert.equal(never.groups.businessRecords?.businessSettings, null);
    assert.equal(
      never.manifest.groups.find((group) => group.group === "businessRecords")?.counts
        .businessSettings,
      0,
    );

    const stored = await captureFixture({
      businessSettings: { version: 1, settings: defaultBusinessSettings(1_600_000_000_000) },
    });
    assert.notEqual(stored.groups.businessRecords?.businessSettings, null);
  });

  it("reads a legacy bare settings object, as the runtime store does", async () => {
    const archive = await captureFixture({ businessSettings: SETTINGS });
    assert.deepEqual(archive.groups.businessRecords?.businessSettings, SETTINGS);
  });
});

describe("archive v4 — business records strictness", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "an unknown field",
      { clients: { version: 1, clients: [{ ...CLIENT, vip: true }] } },
      /unsupported field "vip"/,
    ],
    [
      // `normalizeClient` returns null for a non-string id, so the store drops
      // the row silently and the backup would be short one client.
      "a record the runtime store would skip entirely",
      { clients: { version: 1, clients: [{ ...CLIENT, id: 123 }] } },
      /clients\[0\]\.id must be a string/,
    ],
    [
      "a duplicate id",
      { clients: { version: 1, clients: [CLIENT, CLIENT] } },
      /duplicate client id/,
    ],
    [
      "an unsupported status",
      { projects: { version: 1, projects: [{ ...PROJECT, status: "archived" }] } },
      /must be one of: lead, quoted, active, on_hold, done/,
    ],
    [
      "an unsupported document version",
      { errands: { version: 7, errands: [] } },
      /unsupported document version 7/,
    ],
    [
      "a hazard list the store would deduplicate",
      {
        properties: {
          version: 1,
          properties: [{ ...PROPERTY, hazards: ["asbestos eaves", "asbestos eaves"] }],
        },
      },
      /duplicate hazard/,
    ],
    [
      "an errand location with a latitude but no longitude",
      {
        errands: {
          version: 1,
          errands: [{ ...ERRAND, location: { label: "Depot", lat: -38.1 } }],
        },
      },
      /lat and lon together/,
    ],
    [
      "untrimmed text the store would trim on load",
      { clients: { version: 1, clients: [{ ...CLIENT, name: "  Marlow  " }] } },
      /leading or trailing whitespace/,
    ],
  ];

  for (const [label, override, message] of cases) {
    it(`aborts the capture on ${label}`, async () => {
      const dir = await scratch();
      await writeSource(dir, override);
      await assert.rejects(captureJsonGroups(pathsIn(dir)), (error: unknown) => {
        assert.ok(error instanceof Error, "expected an Error");
        assert.match(error.message, message);
        return true;
      });
    });
  }

  it("aborts when a stored quote total has drifted from its line items", async () => {
    const dir = await scratch();
    await writeSource(dir, { quotes: { version: 1, quotes: [{ ...QUOTE, total: 9999 }] } });
    await assert.rejects(captureJsonGroups(pathsIn(dir)), (error: unknown) => {
      assert.ok(error instanceof StrictBackupError);
      assert.match(
        error.message,
        /quotes record quote-1 is stored in a form the ordinary store changes on load/,
      );
      return true;
    });
    // The forgiving store silently rewrites the total; that is exactly why the
    // capture must not accept it.
    const runtime = await new JsonQuoteStore(pathsIn(dir).quotes, QUIET).list();
    assert.equal(runtime[0]?.total, QUOTE.total);
  });

  it("aborts when a stored invoice payment status disagrees with its payments", async () => {
    const dir = await scratch();
    await writeSource(dir, {
      invoices: { version: 1, invoices: [{ ...INVOICE, paymentStatus: "paid" }] },
    });
    await assert.rejects(captureJsonGroups(pathsIn(dir)), (error: unknown) => {
      assert.ok(error instanceof StrictBackupError);
      assert.match(error.message, /invoices record invoice-1 is stored in a form/);
      return true;
    });
  });

  it("never quarantines a malformed business file the way the store would", async () => {
    const dir = await scratch();
    await writeSource(dir);
    await writeFile(pathsIn(dir).invoices, "{ broken", "utf8");
    await assert.rejects(captureJsonGroups(pathsIn(dir)), StrictBackupError);
    assert.equal(await readFile(pathsIn(dir).invoices, "utf8"), "{ broken");
  });
});

describe("archive v4 — business references the source cannot resolve", () => {
  it("records every broken edge without dropping the record", async () => {
    // Deleting a client leaves its property, project, quote, invoice and
    // enquiry in place: no cascade, no dependency guard.
    const archive = await captureFixture({ clients: { version: 1, clients: [] } });
    assert.equal(archive.groups.businessRecords?.properties.length, 1);
    const edges = archive.manifest.unresolvedReferences.map(
      (entry) => `${entry.collection}.${entry.field}`,
    );
    assert.deepEqual(edges, [
      "enquiries.clientId",
      "invoices.clientId",
      "projects.clientId",
      "properties.clientId",
      "quotes.clientId",
    ]);
    for (const entry of archive.manifest.unresolvedReferences) {
      assert.equal(entry.group, "businessRecords");
      assert.equal(entry.value, "client-1");
      assert.equal(entry.targetCollection, "clients");
    }
  });

  it("records none for a fully connected dataset", async () => {
    const archive = await captureFixture();
    assert.deepEqual(archive.manifest.unresolvedReferences, []);
  });

  it("checks every declared cross-domain edge", () => {
    // Every reference points at an id no collection holds, so each declared edge
    // must appear exactly once. This is the guard against silently dropping a
    // reference field from the checker when a domain gains one.
    const missing = "gone";
    const unresolved = businessUnresolvedReferences({
      clients: [],
      properties: [{ ...PROPERTY, clientId: missing }],
      projects: [{ ...PROJECT, clientId: missing, propertyId: missing }],
      quotes: [{ ...QUOTE, clientId: missing, projectId: missing }],
      invoices: [{ ...INVOICE, clientId: missing, projectId: missing, quoteId: missing }],
      enquiries: [
        { ...ENQUIRY, clientId: missing, propertyId: missing, convertedProjectId: missing },
      ],
      errands: [{ ...ERRAND, projectId: missing }],
      businessSettings: null,
    } as never);
    assert.deepEqual(
      unresolved.map((entry) => `${entry.collection}.${entry.field}`).sort(),
      [
        "enquiries.clientId",
        "enquiries.convertedProjectId",
        "enquiries.propertyId",
        "errands.projectId",
        "invoices.clientId",
        "invoices.projectId",
        "invoices.quoteId",
        "projects.clientId",
        "projects.propertyId",
        "properties.clientId",
        "quotes.clientId",
        "quotes.projectId",
      ].sort(),
    );
  });
});

describe("archive v4 — business records restore", () => {
  it("materialises every domain and both readers agree", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await restoreArchiveV4(archive, destination, { allowPartial: true });

    const strict = await readBusinessGroup({
      clients: path.join(destination, "jarvis-clients.json"),
      properties: path.join(destination, "jarvis-properties.json"),
      projects: path.join(destination, "jarvis-projects.json"),
      quotes: path.join(destination, "jarvis-quotes.json"),
      invoices: path.join(destination, "jarvis-invoices.json"),
      enquiries: path.join(destination, "jarvis-enquiries.json"),
      errands: path.join(destination, "jarvis-errands.json"),
      businessSettings: path.join(destination, "jarvis-business-settings.json"),
    });
    assert.deepEqual(strict, archive.groups.businessRecords);

    assert.deepEqual(
      await new JsonClientStore(path.join(destination, "jarvis-clients.json"), QUIET).list(),
      [CLIENT],
    );
    assert.deepEqual(
      await new JsonInvoiceStore(path.join(destination, "jarvis-invoices.json"), QUIET).list(),
      [INVOICE],
    );
    assert.deepEqual(
      await new JsonBusinessSettingsStore(
        path.join(destination, "jarvis-business-settings.json"),
        QUIET,
      ).get(),
      SETTINGS,
    );
  });

  it("does not write a settings file that was never written in the source", async () => {
    const archive = await captureFixture({ businessSettings: null });
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await restoreArchiveV4(archive, destination, { allowPartial: true });

    const marker = JSON.parse(
      await readFile(path.join(destination, ".jarvis-archive-v4-complete.json"), "utf8"),
    ) as { files: string[] };
    assert.equal(marker.files.includes("jarvis-business-settings.json"), false);
    // The runtime still reads defaults, so "never configured" is reproduced exactly.
    const settings = await new JsonBusinessSettingsStore(
      path.join(destination, "jarvis-business-settings.json"),
      QUIET,
    ).get();
    assert.equal(settings.businessName, defaultBusinessSettings().businessName);
  });

  it("leaves an interrupted business restore incomplete and un-retryable", async () => {
    const archive = await captureFixture();
    const dir = await scratch();
    const destination = path.join(dir, "restore");
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true, injectAfterWrite: "quotes" }),
      /Injected failure after writing quotes/,
    );
    const marker = await readFile(
      path.join(destination, ".jarvis-archive-v4-complete.json"),
      "utf8",
    ).catch(() => null);
    assert.equal(marker, null);
    await assert.rejects(
      restoreArchiveV4(archive, destination, { allowPartial: true }),
      /already exists; refusing to merge/,
    );
  });

  it("is still partial: three required groups remain absent", async () => {
    const { manifest } = await captureFixture();
    assert.equal(manifest.completeness, "partial");
    assert.deepEqual(manifest.coverage.present, ["core", "memory", "businessRecords"]);
    assert.deepEqual(manifest.coverage.absent, [
      "notesAndEvidence",
      "orchestration",
      "quoteAggregate",
    ]);
  });
});
