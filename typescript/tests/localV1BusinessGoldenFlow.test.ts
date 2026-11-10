import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import type { DailyBrief } from "../src/briefs/brief.js";
import { JsonClientStore } from "../src/clients/jsonClientStore.js";
import { JsonEnquiryStore } from "../src/enquiries/jsonEnquiryStore.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import { JsonInvoiceStore } from "../src/invoices/jsonInvoiceStore.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";
import { JSONPersistence } from "../src/persistence/jsonPersistence.js";
import { JsonProjectStore } from "../src/projects/jsonProjectStore.js";
import { JsonPropertyStore } from "../src/properties/jsonPropertyStore.js";
import { JsonQuoteStore } from "../src/quotes/jsonQuoteStore.js";
import type {
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
} from "../src/quotes/quoteDeliveryRepository.js";
import { quoteRevisionFingerprint } from "../src/quotes/quoteFingerprints.js";
import {
  QuoteInvalidTransitionError,
  QuoteVersionConflictError,
  applyDraftPatch,
  assertRevisionTransition,
  computeQuoteTotals,
  type QuoteRevision,
  type QuoteSnapshot,
} from "../src/quotes/quoteLifecycle.js";
import type {
  QuotePdfArtifactContent,
  QuotePdfArtifactRepository,
} from "../src/quotes/quotePdfArtifactRepository.js";
import { renderFinalizedQuotePdf } from "../src/quotes/quotePdfRenderer.js";
import type { QuoteRepository, QuoteSummary } from "../src/quotes/quoteRepository.js";
import { captureCredentials } from "../src/settings/credentialsStatus.js";

/**
 * Off-host exercise of the Local V1 golden business workflow (#697):
 * enquiry -> client/property -> project -> quote draft/edit/finalise/PDF ->
 * delivery receipt -> invoice draft -> daily brief/HUD -> restart.
 *
 * Operator writes go through MCP, which calls the HTTP API. Review and finalise
 * are owner-driven HTTP calls because MCP deliberately exposes neither.
 *
 * What this does NOT prove:
 * - The quote lifecycle, delivery ledger and PDF artifact store here are
 *   file-backed test doubles built on the real domain helpers. The Convex
 *   implementations are covered by their own contract suites.
 * - No email is sent. The succeeded delivery receipt is written straight into
 *   the ledger double; the governed `quotes:send` path (#294, #297) is host
 *   commissioning and is not exercised.
 */

const TOKEN = "local-v1-business-golden-secret";
const OWNER = "owner-local-v1";
const ISSUER = { name: "The Beez Treez", email: "quotes@example.com" };
const RECIPIENT = { name: "Pat Example", email: "pat@example.com" };

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "local-v1-business-golden",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: TOKEN,
  previousToken: undefined,
};

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

type StoredQuote = { snapshot: QuoteSnapshot; revisions: QuoteRevision[] };

/** File-backed quote lifecycle double. State survives a new instance on the same file. */
class FileQuoteRepository implements QuoteRepository {
  constructor(private readonly file: string) {}

  #load(): StoredQuote[] {
    return readJson<StoredQuote[]>(this.file, []);
  }

  #save(rows: StoredQuote[]): void {
    writeFileSync(this.file, JSON.stringify(rows));
  }

  #mutate(
    quoteId: string,
    revision: number,
    expectedAggregateVersion: number,
    change: (current: QuoteSnapshot) => QuoteRevision,
  ): QuoteSnapshot {
    const rows = this.#load();
    const row = rows.find((candidate) => candidate.snapshot.aggregate.quoteId === quoteId);
    if (!row || row.snapshot.aggregate.currentRevision !== revision) {
      throw new QuoteInvalidTransitionError("Quote revision is not the current revision.");
    }
    if (row.snapshot.aggregate.aggregateVersion !== expectedAggregateVersion) {
      throw new QuoteVersionConflictError();
    }
    const next = change(row.snapshot);
    row.snapshot = {
      aggregate: {
        ...row.snapshot.aggregate,
        aggregateVersion: row.snapshot.aggregate.aggregateVersion + 1,
        updatedAt: next.updatedAt,
      },
      revision: next,
    };
    this.#save(rows);
    return structuredClone(row.snapshot);
  }

  #transition(
    input: { quoteId: string; revision: number } & Record<
      "expectedAggregateVersion" | "expectedRevisionVersion",
      number
    >,
    to: QuoteRevision["status"],
    extra: (current: QuoteSnapshot) => Partial<QuoteRevision> = () => ({}),
  ): QuoteSnapshot {
    return this.#mutate(
      input.quoteId,
      input.revision,
      input.expectedAggregateVersion,
      (current) => {
        if (current.revision.revisionVersion !== input.expectedRevisionVersion) {
          throw new QuoteVersionConflictError();
        }
        assertRevisionTransition(current.revision.status, to);
        return {
          ...current.revision,
          ...extra(current),
          status: to,
          revisionVersion: current.revision.revisionVersion + 1,
          updatedAt: Date.now(),
        };
      },
    );
  }

  async createQuote(input: Parameters<QuoteRepository["createQuote"]>[0]): Promise<QuoteSnapshot> {
    const rows = this.#load();
    const quoteId = `quote-${rows.length + 1}`;
    const now = Date.now();
    const totals = computeQuoteTotals(input.lineItems, input.taxRate);
    const snapshot: QuoteSnapshot = {
      aggregate: {
        quoteId,
        ownerId: OWNER,
        clientId: input.clientId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        number: input.number,
        currentRevision: 1,
        currentRevisionId: `${quoteId}-revision-1`,
        aggregateVersion: 0,
        commercialStatus: "open",
        createdAt: now,
        updatedAt: now,
      },
      revision: {
        revisionId: `${quoteId}-revision-1`,
        ownerId: OWNER,
        quoteId,
        revision: 1,
        revisionVersion: 0,
        status: "draft",
        lineItems: input.lineItems.map((item) => ({ ...item })),
        ...totals,
        ...(input.taxRate === undefined ? {} : { taxRate: input.taxRate }),
        ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        currency: "AUD",
        termsIncluded: input.termsIncluded,
        createdAt: now,
        updatedAt: now,
      },
    };
    rows.push({ snapshot, revisions: [] });
    this.#save(rows);
    return structuredClone(snapshot);
  }

  async getQuote(quoteId: string): Promise<QuoteSnapshot | null> {
    return this.#load().find((row) => row.snapshot.aggregate.quoteId === quoteId)?.snapshot ?? null;
  }

  async listQuotes(): Promise<QuoteSummary[]> {
    return this.#load().map(({ snapshot }) => ({
      quoteId: snapshot.aggregate.quoteId,
      clientId: snapshot.aggregate.clientId,
      ...(snapshot.aggregate.projectId === undefined
        ? {}
        : { projectId: snapshot.aggregate.projectId }),
      number: snapshot.aggregate.number,
      currentRevision: snapshot.aggregate.currentRevision,
      aggregateVersion: snapshot.aggregate.aggregateVersion,
      revisionStatus: snapshot.revision.status,
      commercialStatus: snapshot.aggregate.commercialStatus,
      total: snapshot.revision.total,
      currency: "AUD",
      updatedAt: snapshot.aggregate.updatedAt,
    }));
  }

  async updateDraft(input: Parameters<QuoteRepository["updateDraft"]>[0]): Promise<QuoteSnapshot> {
    return this.#mutate(input.quoteId, input.revision, input.expectedAggregateVersion, (current) =>
      applyDraftPatch(current.revision, input.patch, input.expectedRevisionVersion),
    );
  }

  async submitForReview(
    input: Parameters<QuoteRepository["submitForReview"]>[0],
  ): Promise<QuoteSnapshot> {
    return this.#transition(input, "reviewed", () => ({ reviewedAt: Date.now() }));
  }

  async reopenForEditing(
    input: Parameters<QuoteRepository["reopenForEditing"]>[0],
  ): Promise<QuoteSnapshot> {
    return this.#transition(input, "draft");
  }

  async finalizeRevision(
    input: Parameters<QuoteRepository["finalizeRevision"]>[0],
  ): Promise<QuoteSnapshot> {
    return this.#transition(input, "finalized", ({ aggregate, revision }) => ({
      finalizedAt: Date.now(),
      fingerprint: quoteRevisionFingerprint({
        ownerId: aggregate.ownerId,
        quoteId: aggregate.quoteId,
        revision: revision.revision,
        clientId: aggregate.clientId,
        ...(aggregate.projectId === undefined ? {} : { projectId: aggregate.projectId }),
        number: aggregate.number,
        lineItems: revision.lineItems,
        subtotal: revision.subtotal,
        ...(revision.taxRate === undefined ? {} : { taxRate: revision.taxRate }),
        tax: revision.tax,
        total: revision.total,
        currency: revision.currency,
        ...(revision.validUntil === undefined ? {} : { validUntil: revision.validUntil }),
        ...(revision.notes === undefined ? {} : { notes: revision.notes }),
        termsIncluded: revision.termsIncluded,
      }),
    }));
  }

  createRevisionFromFinalized(): Promise<never> {
    return Promise.reject(new Error("fork is outside the golden flow"));
  }

  recordCommercialOutcome(): Promise<never> {
    return Promise.reject(new Error("commercial outcome is outside the golden flow"));
  }

  cleanup(): Promise<never> {
    return Promise.reject(new Error("cleanup is outside the golden flow"));
  }
}

/** Read-only delivery ledger double over a file. Nothing here sends anything. */
function fileDeliveryLedger(file: string): QuoteDeliveryRepository {
  const unused = (): Promise<never> =>
    Promise.reject(new Error("the golden flow must not start or mutate a delivery"));
  return {
    getBySendScope: unused,
    createPending: unused,
    markExecuting: unused,
    bindProviderReference: unused,
    complete: unused,
    markIndeterminate: unused,
    reconcile: unused,
    async listForQuote(input) {
      return readJson<QuoteDeliveryAttempt[]>(file, []).filter(
        (attempt) => attempt.quoteId === input.quoteId,
      );
    },
    cleanup: unused,
  };
}

/** Renders the finalized revision with the real renderer, as the stored artifact would be. */
function renderedPdfArtifacts(quotes: QuoteRepository): QuotePdfArtifactRepository {
  return {
    async getForRevision(input): Promise<QuotePdfArtifactContent | null> {
      const snapshot = await quotes.getQuote(input.quoteId);
      if (
        !snapshot ||
        snapshot.revision.revision !== input.revision ||
        snapshot.revision.status !== "finalized" ||
        snapshot.revision.fingerprint !== input.expectedRevisionFingerprint
      ) {
        return null;
      }
      const rendered = renderFinalizedQuotePdf({
        snapshot,
        issuer: ISSUER,
        client: RECIPIENT,
        generatedAt: "2026-11-11T00:00:00.000Z",
      });
      return {
        quoteId: input.quoteId,
        revisionId: snapshot.revision.revisionId,
        revision: input.revision,
        revisionFingerprint: input.expectedRevisionFingerprint,
        filename: rendered.filename,
        mediaType: rendered.mediaType,
        digest: rendered.digest,
        byteLength: rendered.byteLength,
        bytes: rendered.bytes,
      };
    },
  };
}

function storesAt(dir: string) {
  const quoteRepository = new FileQuoteRepository(path.join(dir, "golden-quote-lifecycle.json"));
  return {
    persistence: new JSONPersistence(path.join(dir, "jarvis-state.json")),
    clientStore: new JsonClientStore(path.join(dir, "jarvis-clients.json")),
    propertyStore: new JsonPropertyStore(path.join(dir, "jarvis-properties.json")),
    projectStore: new JsonProjectStore(path.join(dir, "jarvis-projects.json")),
    enquiryStore: new JsonEnquiryStore(path.join(dir, "jarvis-enquiries.json")),
    invoiceStore: new JsonInvoiceStore(path.join(dir, "jarvis-invoices.json")),
    quoteStore: new JsonQuoteStore(path.join(dir, "jarvis-quotes.json")),
    quoteRepository,
    quoteDeliveryRepository: fileDeliveryLedger(path.join(dir, "golden-quote-deliveries.json")),
    quotePdfArtifactRepository: renderedPdfArtifacts(quoteRepository),
  };
}

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

type Harness = {
  client: Client;
  app: NestFastifyApplication;
  baseUrl: string;
  close: () => Promise<void>;
};

const open: Harness[] = [];
const directories: string[] = [];

async function start(dir: string): Promise<Harness> {
  const app = await createJarvisHttpApp({
    ...storesAt(dir),
    providerName: "json",
    config: CONFIG,
    credentialsRuntime: captureCredentials({
      serviceToken: TOKEN,
      httpHost: "127.0.0.1",
      httpPort: 3100,
      mcpHost: "127.0.0.1",
      mcpPort: 8797,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    }),
    logger: false,
  });
  await app.listen(0, "127.0.0.1");
  const baseUrl = await app.getUrl();
  const server = createJarvisMcpServer(
    new JarvisApiClient({ baseUrl: new URL(`${baseUrl}/`), serviceToken: TOKEN }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "local-v1-business-golden", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const harness: Harness = {
    client,
    app,
    baseUrl,
    async close() {
      await client.close();
      await server.close();
      await app.close();
    },
  };
  open.push(harness);
  return harness;
}

async function raw(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await raw(client, name, args);
  const text = result.content?.map((part) => part.text ?? "").join(" ") ?? "";
  assert.notEqual(result.isError, true, `${name} failed: ${text}`);
  assert.ok(result.structuredContent, `${name} returned no structured content`);
  return result.structuredContent;
}

function http(harness: Harness, method: string, route: string, body?: object) {
  return fetch(`${harness.baseUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function brief(client: Client): Promise<DailyBrief> {
  return (await call(client, "get_daily_brief")).brief as DailyBrief;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Local V1 golden business workflow", () => {
  it("carries one enquiry through client, property, job, quote, PDF, receipt, invoice, brief, HUD and restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jarvis-lv1-golden-"));
    directories.push(dir);
    const first = await start(dir);
    const mcp = first.client;

    // Finalising and sending stay off the model-facing surface.
    const toolNames = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const forbidden of ["finalize_quote", "send_quote", "issue_invoice"]) {
      assert.equal(toolNames.includes(forbidden), false, `${forbidden} must not be exposed`);
    }

    // --- client and property ---------------------------------------------
    const client = (
      await call(mcp, "create_client", {
        name: "Pat Example",
        contacts: [{ label: "email", value: "pat@example.com" }],
      })
    ).client as { id: string; name: string };
    assert.equal(client.name, "Pat Example");

    const property = (
      await call(mcp, "create_property", {
        clientId: client.id,
        address: "12 Wattle Lane",
        hazards: ["powerlines over rear fence"],
        accessNotes: "Rear lane access only.",
      })
    ).property as { id: string; clientId: string; hazards: string[] };
    assert.equal(property.clientId, client.id);
    assert.deepEqual(property.hazards, ["powerlines over rear fence"]);

    // --- enquiry ------------------------------------------------------------
    const enquiryArgs = {
      clientId: client.id,
      propertyId: property.id,
      source: "phone",
      requestedWork: "Crown reduction on the rear gum",
      urgency: "urgent",
      duplicateKey: "pat-2026-11-11-0900",
    };
    const enquiry = (await call(mcp, "create_enquiry", enquiryArgs)).enquiry as {
      id: string;
      status: string;
    };
    assert.equal(enquiry.status, "open");
    const retried = (await call(mcp, "create_enquiry", enquiryArgs)).enquiry as { id: string };
    assert.equal(retried.id, enquiry.id, "a retried log must not create a second enquiry");

    const afterEnquiry = await brief(mcp);
    assert.equal(afterEnquiry.enquiries.openCount, 1);
    assert.equal(afterEnquiry.enquiries.countsByUrgency.urgent, 1);
    assert.equal(afterEnquiry.enquiries.open[0]?.id, enquiry.id);

    // --- enquiry -> job -----------------------------------------------------
    const converted = await call(mcp, "convert_enquiry_to_project", {
      enquiryId: enquiry.id,
      title: "Wattle Lane crown reduction",
    });
    const project = converted.project as {
      id: string;
      clientId: string;
      propertyId?: string;
      title: string;
      status: string;
    };
    assert.equal(converted.replayed, false);
    assert.equal(project.clientId, client.id);
    assert.equal(project.propertyId, property.id, "the job keeps the enquiry's property");
    assert.equal(project.status, "lead");
    assert.equal((converted.enquiry as { status: string }).status, "converted");
    assert.equal(
      (converted.enquiry as { convertedProjectId?: string }).convertedProjectId,
      project.id,
    );
    const replay = await call(mcp, "convert_enquiry_to_project", { enquiryId: enquiry.id });
    assert.equal(replay.replayed, true);
    assert.equal((replay.project as { id: string }).id, project.id);

    const afterConversion = await brief(mcp);
    assert.equal(afterConversion.enquiries.openCount, 0);
    assert.equal(afterConversion.projects.countsByStatus.lead, 1);

    // The job becomes active once Benny books it in; it then shows in the brief.
    const booked = (await call(mcp, "update_project", { projectId: project.id, status: "active" }))
      .project as { status: string; propertyId?: string };
    assert.equal(booked.status, "active");
    assert.equal(booked.propertyId, property.id);
    const afterBooking = await brief(mcp);
    assert.deepEqual(
      afterBooking.projects.active.map((item) => item.id),
      [project.id],
    );
    const listed = await call(mcp, "list_projects", {});
    assert.equal(listed.count, 1);

    // --- quote draft and edit -------------------------------------------------
    const drafted = (
      await call(mcp, "create_quote_draft", {
        clientId: client.id,
        projectId: project.id,
        number: "Q-2026-001",
        termsIncluded: true,
        lineItems: [{ description: "Crown reduction", quantity: 1, unitPrice: 450 }],
      })
    ).quote as QuoteSnapshot;
    const quoteId = drafted.aggregate.quoteId;
    assert.equal(drafted.revision.status, "draft");
    assert.equal(drafted.revision.total, 450);
    assert.equal(drafted.aggregate.projectId, project.id);

    const edited = (
      await call(mcp, "update_quote_draft", {
        quoteId,
        revision: 1,
        expectedAggregateVersion: drafted.aggregate.aggregateVersion,
        expectedRevisionVersion: drafted.revision.revisionVersion,
        patch: {
          lineItems: [
            { description: "Crown reduction", quantity: 1, unitPrice: 450 },
            { description: "Green waste removal", quantity: 2, unitPrice: 75 },
          ],
          taxRate: 0.1,
        },
      })
    ).quote as QuoteSnapshot;
    assert.equal(edited.revision.subtotal, 600);
    assert.equal(edited.revision.tax, 60);
    assert.equal(edited.revision.total, 660);

    const stale = await raw(mcp, "update_quote_draft", {
      quoteId,
      revision: 1,
      expectedAggregateVersion: drafted.aggregate.aggregateVersion,
      expectedRevisionVersion: drafted.revision.revisionVersion,
      patch: { notes: "stale edit" },
    });
    assert.equal(stale.isError, true, "a stale draft edit must be refused");

    const draftBrief = await brief(mcp);
    assert.ok(draftBrief.quotes.drafts.some((quote) => quote.id === quoteId));
    assert.equal(draftBrief.quotes.pipelineTotal, 0);

    // --- owner review and finalise (HTTP only) -------------------------------
    const envelope = (snapshot: QuoteSnapshot) => ({
      expectedAggregateVersion: snapshot.aggregate.aggregateVersion,
      expectedRevisionVersion: snapshot.revision.revisionVersion,
    });
    const reviewResponse = await http(
      first,
      "POST",
      `/api/v1/quotes/${quoteId}/revisions/1/review`,
      envelope(edited),
    );
    assert.equal(reviewResponse.status, 200);
    const reviewed = ((await reviewResponse.json()) as { data: QuoteSnapshot }).data;
    const finalizeResponse = await http(
      first,
      "POST",
      `/api/v1/quotes/${quoteId}/revisions/1/finalize`,
      { ...envelope(reviewed), issuer: ISSUER, client: RECIPIENT },
    );
    assert.equal(finalizeResponse.status, 200);
    const finalized = ((await finalizeResponse.json()) as { data: QuoteSnapshot }).data;
    assert.equal(finalized.revision.status, "finalized");
    assert.match(finalized.revision.fingerprint ?? "", /^quote-revision:v1:sha256:/);

    const afterFinalEdit = await raw(mcp, "update_quote_draft", {
      quoteId,
      revision: 1,
      ...envelope(finalized),
      patch: { notes: "edit after finalise" },
    });
    assert.equal(afterFinalEdit.isError, true, "a finalized revision must be immutable");

    // --- PDF --------------------------------------------------------------------
    const pdf = await http(first, "GET", `/api/v1/quotes/${quoteId}/revisions/1/pdf`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-type") ?? "", /^application\/pdf/);
    assert.equal(pdf.headers.get("cache-control"), "no-store");
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(pdf.headers.get("x-quote-pdf-digest"));

    // Finalised but undelivered: still not awaiting a response.
    const undelivered = await brief(mcp);
    assert.equal(undelivered.quotes.awaitingResponse.length, 0);
    assert.equal(undelivered.quotes.pipelineTotal, 0);

    // --- delivery receipt (ledger double; no send is exercised) ---------------
    const receipt: QuoteDeliveryAttempt = {
      deliveryAttemptId: "delivery-golden-1",
      ownerId: OWNER,
      quoteId,
      revision: 1,
      revisionId: finalized.revision.revisionId,
      revisionFingerprint: finalized.revision.fingerprint ?? "",
      recipient: "pat@example.com",
      channel: "email",
      sendFingerprint: "quote-send:v1:sha256:golden",
      idempotencyKey: "golden-send-1",
      approvalId: "golden-send-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:golden",
      status: "succeeded",
      provider: "test-email-provider",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now(),
    };
    writeFileSync(path.join(dir, "golden-quote-deliveries.json"), JSON.stringify([receipt]));

    const delivered = await brief(mcp);
    assert.deepEqual(
      delivered.quotes.awaitingResponse.map((quote) => quote.id),
      [quoteId],
    );
    assert.equal(delivered.quotes.pipelineTotal, 660);
    assert.equal(delivered.quotes.drafts.length, 0);

    // --- invoice draft -----------------------------------------------------------
    const invoice = (
      await call(mcp, "create_invoice_draft", {
        clientId: client.id,
        projectId: project.id,
        quoteId,
        number: "INV-2026-001",
        taxRate: 0.1,
        lineItems: [
          { description: "Crown reduction", quantity: 1, unitPrice: 450 },
          { description: "Green waste removal", quantity: 2, unitPrice: 75 },
        ],
        duplicateKey: "inv-q-2026-001",
      })
    ).invoice as { id: string; status: string; total: number; quoteId?: string };
    assert.equal(invoice.status, "draft");
    assert.equal(invoice.total, 660);
    assert.equal(invoice.quoteId, quoteId);

    const invoiceEdited = (
      await call(mcp, "update_invoice_draft", { invoiceId: invoice.id, dueDate: "14 days" })
    ).invoice as { dueDate?: string; total: number };
    assert.equal(invoiceEdited.dueDate, "14 days");
    assert.equal(invoiceEdited.total, 660);

    // --- brief and HUD agree -------------------------------------------------------
    const finalBrief = await brief(mcp);
    assert.equal(finalBrief.invoices.draftCount, 1);
    assert.equal(finalBrief.invoices.unpaidCount, 0);

    const hudResponse = await http(first, "GET", "/api/v1/hud/snapshot");
    assert.equal(hudResponse.status, 200);
    const hud = (await hudResponse.json()) as Record<string, unknown>;
    const register = hud.quoteRegister as {
      status: string;
      quotes: Array<{ quoteId: string; revisionStatus: string; total: number }>;
    };
    assert.equal(register.status, "ready");
    assert.deepEqual(
      register.quotes.map((quote) => [quote.quoteId, quote.revisionStatus, quote.total]),
      [[quoteId, "finalized", 660]],
    );
    const hudBrief = hud.brief as DailyBrief;
    assert.equal(hudBrief.quotes.pipelineTotal, 660);
    assert.equal(hudBrief.invoices.draftCount, 1);

    // --- restart: new app and new store instances on the same files --------------
    await first.close();
    open.splice(open.indexOf(first), 1);
    const second = await start(dir);

    assert.equal(
      ((await call(second.client, "get_client", { clientId: client.id })).client as { id: string })
        .id,
      client.id,
    );
    assert.equal(
      (
        (await call(second.client, "get_property", { propertyId: property.id })).property as {
          id: string;
        }
      ).id,
      property.id,
    );
    const enquiryAfter = (await call(second.client, "get_enquiry", { enquiryId: enquiry.id }))
      .enquiry as { status: string; convertedProjectId?: string };
    assert.equal(enquiryAfter.status, "converted");
    assert.equal(enquiryAfter.convertedProjectId, project.id);
    assert.equal(
      (
        (await call(second.client, "get_project", { projectId: project.id })).project as {
          title: string;
        }
      ).title,
      "Wattle Lane crown reduction",
    );
    const quoteAfter = (await call(second.client, "get_quote", { quoteId })).quote as QuoteSnapshot;
    assert.equal(quoteAfter.revision.status, "finalized");
    assert.equal(quoteAfter.revision.fingerprint, finalized.revision.fingerprint);
    assert.equal(quoteAfter.revision.total, 660);
    const invoiceAfter = (await call(second.client, "get_invoice", { invoiceId: invoice.id }))
      .invoice as { status: string; total: number; dueDate?: string };
    assert.deepEqual(
      [invoiceAfter.status, invoiceAfter.total, invoiceAfter.dueDate],
      ["draft", 660, "14 days"],
    );

    const restartedBrief = await brief(second.client);
    assert.deepEqual(restartedBrief.quotes, finalBrief.quotes);
    assert.deepEqual(restartedBrief.invoices, finalBrief.invoices);
    assert.deepEqual(restartedBrief.enquiries, finalBrief.enquiries);
    assert.deepEqual(
      restartedBrief.projects.active.map((item) => item.id),
      finalBrief.projects.active.map((item) => item.id),
    );

    const pdfAfter = await http(second, "GET", `/api/v1/quotes/${quoteId}/revisions/1/pdf`);
    assert.equal(pdfAfter.status, 200);
    assert.equal(pdfAfter.headers.get("x-quote-pdf-digest"), pdf.headers.get("x-quote-pdf-digest"));
  });
});
