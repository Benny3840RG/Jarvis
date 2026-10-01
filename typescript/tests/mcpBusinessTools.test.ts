import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

/**
 * End-to-end coverage for the business MCP tools (issue #658): each call goes
 * MCP client -> MCP server -> JarvisApiClient -> the real Nest HTTP app and its
 * request validators -> in-memory stores. This proves the tool arguments match
 * what the HTTP boundary actually accepts, not just which route is called.
 */

const TOKEN = "business-tools-secret";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "mcp-business-tools-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: TOKEN,
  previousToken: undefined,
};

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("task/reminder persistence must not be reached by business tools");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: forbidden,
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

type Harness = { client: Client; close: () => Promise<void> };

const openHarnesses: Harness[] = [];

async function startHarness(): Promise<Harness> {
  const app: NestFastifyApplication = await createJarvisHttpApp({
    persistence: unusedPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
  });
  await app.listen(0, "127.0.0.1");
  const baseUrl = new URL(`${await app.getUrl()}/`);
  const apiClient = new JarvisApiClient({ baseUrl, serviceToken: TOKEN });
  const server = createJarvisMcpServer(apiClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "jarvis-business-tools-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const harness: Harness = {
    client,
    async close() {
      await client.close();
      await server.close();
      await app.close();
    },
  };
  openHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
});

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** A successful call's structured payload; fails loudly with the tool's own message otherwise. */
async function ok<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await call(client, name, args);
  const text = result.content?.map((part) => part.text ?? "").join(" ") ?? "";
  assert.notEqual(result.isError, true, `${name} failed: ${text}`);
  assert.ok(result.structuredContent, `${name} returned no structured content`);
  return result.structuredContent as T;
}

/**
 * The call must fail. An input-schema rejection may surface either as an
 * `isError` result or as a protocol error, depending on the SDK path; both are
 * refusals, and neither may reach the HTTP store.
 */
async function refused(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  pattern?: RegExp,
): Promise<void> {
  let message: string;
  try {
    const result = await call(client, name, args);
    assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
    message = result.content?.map((part) => part.text ?? "").join(" ") ?? "";
  } catch (error: unknown) {
    if (error instanceof assert.AssertionError) throw error;
    message = error instanceof Error ? error.message : String(error);
  }
  assert.doesNotMatch(message, /Tool \S+ not found/, `${name} is not registered`);
  if (pattern) assert.match(message, pattern);
}

type PropertyShape = {
  id: string;
  clientId: string;
  address: string;
  hazards: string[];
  accessNotes?: string;
  serviceNotes?: string;
};

type EnquiryShape = {
  id: string;
  clientId: string;
  status: string;
  requestedWork: string;
  urgency: string;
  closedReason?: string;
  convertedProjectId?: string;
};

type InvoiceShape = {
  id: string;
  status: string;
  number: string;
  subtotal: number;
  tax: number;
  total: number;
  notes?: string;
};

describe("business MCP tools: properties", () => {
  it("creates, reads, filters, updates, clears notes, and deletes a property", async () => {
    const { client } = await startHarness();

    const { property } = await ok<{ property: PropertyShape }>(client, "create_property", {
      clientId: "client-1",
      address: "12 Example St, Geelong",
      hazards: ["Steep slope", "Steep slope", "Dog on site"],
      accessNotes: "Side gate code from client",
    });
    assert.equal(property.address, "12 Example St, Geelong");
    assert.deepEqual(property.hazards, ["Steep slope", "Dog on site"], "server de-duplicates");

    await ok(client, "create_property", { clientId: "client-2", address: "9 Other Rd" });

    const fetched = await ok<{ property: PropertyShape }>(client, "get_property", {
      propertyId: property.id,
    });
    assert.equal(fetched.property.id, property.id);

    const filtered = await ok<{ properties: PropertyShape[]; count: number }>(
      client,
      "list_properties",
      { clientId: "client-1" },
    );
    assert.equal(filtered.count, 1);
    assert.equal(filtered.properties[0]?.id, property.id);
    const all = await ok<{ count: number }>(client, "list_properties");
    assert.equal(all.count, 2);

    const updated = await ok<{ property: PropertyShape }>(client, "update_property", {
      propertyId: property.id,
      serviceNotes: "Green waste to the left of the shed",
      accessNotes: null,
    });
    assert.equal(updated.property.serviceNotes, "Green waste to the left of the shed");
    assert.equal(updated.property.accessNotes, undefined, "null clears access notes");

    const removed = await ok<{ property: PropertyShape }>(client, "delete_property", {
      propertyId: property.id,
    });
    assert.equal(removed.property.id, property.id);
    await refused(client, "get_property", { propertyId: property.id }, /not found/i);
  });

  it("refuses empty input, unchanged updates, and unknown properties", async () => {
    const { client } = await startHarness();
    await refused(client, "create_property", { clientId: "client-1", address: "   " });
    await refused(client, "update_property", { propertyId: "missing" }, /requires/i);
    await refused(
      client,
      "update_property",
      { propertyId: "missing", address: "1 New St" },
      /not found/i,
    );
    const { count } = await ok<{ count: number }>(client, "list_properties");
    assert.equal(count, 0, "no refused call created a property");
  });
});

describe("business MCP tools: enquiries", () => {
  it("logs, replays, filters, updates, closes and converts enquiries", async () => {
    const { client } = await startHarness();

    const first = await ok<{ enquiry: EnquiryShape }>(client, "create_enquiry", {
      clientId: "client-1",
      source: "phone",
      requestedWork: "Prune two gums near the fence",
      urgency: "urgent",
      duplicateKey: "phone-0412-0930",
    });
    assert.equal(first.enquiry.status, "open");
    assert.equal(first.enquiry.urgency, "urgent");

    const replay = await ok<{ enquiry: EnquiryShape }>(client, "create_enquiry", {
      clientId: "client-1",
      source: "phone",
      requestedWork: "Prune two gums near the fence",
      urgency: "urgent",
      duplicateKey: "phone-0412-0930",
    });
    assert.equal(replay.enquiry.id, first.enquiry.id, "a retried log does not duplicate");

    const second = await ok<{ enquiry: EnquiryShape }>(client, "create_enquiry", {
      clientId: "client-2",
      source: "website form",
      requestedWork: "Quarterly lawn and edge maintenance",
    });
    assert.equal(second.enquiry.urgency, "standard");

    const updated = await ok<{ enquiry: EnquiryShape }>(client, "update_enquiry", {
      enquiryId: first.enquiry.id,
      requestedWork: "Prune two gums and remove the dead wattle",
      siteNotes: "Power lines on the street side",
    });
    assert.equal(updated.enquiry.requestedWork, "Prune two gums and remove the dead wattle");

    const closed = await ok<{ enquiry: EnquiryShape }>(client, "close_enquiry", {
      enquiryId: second.enquiry.id,
      reason: "Client went with a cheaper quote",
    });
    assert.equal(closed.enquiry.status, "closed");
    assert.equal(closed.enquiry.closedReason, "Client went with a cheaper quote");

    const converted = await ok<{
      enquiry: EnquiryShape;
      project: { id: string; clientId: string; title: string };
      replayed: boolean;
    }>(client, "convert_enquiry_to_project", {
      enquiryId: first.enquiry.id,
      title: "Gum pruning and wattle removal",
    });
    assert.equal(converted.enquiry.status, "converted");
    assert.equal(converted.enquiry.convertedProjectId, converted.project.id);
    assert.equal(converted.project.clientId, "client-1");
    assert.equal(converted.project.title, "Gum pruning and wattle removal");
    assert.equal(converted.replayed, false);

    const open = await ok<{ count: number }>(client, "list_enquiries", { status: "open" });
    assert.equal(open.count, 0);
    const forClient = await ok<{ enquiries: EnquiryShape[]; count: number }>(
      client,
      "list_enquiries",
      { clientId: "client-2" },
    );
    assert.equal(forClient.count, 1);
    assert.equal(forClient.enquiries[0]?.status, "closed");

    const fetched = await ok<{ enquiry: EnquiryShape }>(client, "get_enquiry", {
      enquiryId: first.enquiry.id,
    });
    assert.equal(fetched.enquiry.status, "converted");
  });

  it("refuses closed-enquiry conversion, bad urgency, empty updates and unknown ids", async () => {
    const { client } = await startHarness();
    const { enquiry } = await ok<{ enquiry: EnquiryShape }>(client, "create_enquiry", {
      clientId: "client-1",
      source: "phone",
      requestedWork: "Gutter clean",
    });
    await ok(client, "close_enquiry", { enquiryId: enquiry.id, reason: "Duplicate call" });
    await refused(client, "convert_enquiry_to_project", { enquiryId: enquiry.id });
    await refused(client, "create_enquiry", {
      clientId: "client-1",
      source: "phone",
      requestedWork: "Gutter clean",
      urgency: "whenever",
    });
    await refused(client, "update_enquiry", { enquiryId: enquiry.id }, /requires/i);
    await refused(client, "get_enquiry", { enquiryId: "missing" }, /not found/i);
    await refused(client, "close_enquiry", { enquiryId: "missing", reason: "x" }, /not found/i);
    const { count } = await ok<{ count: number }>(client, "list_enquiries");
    assert.equal(count, 1);
  });
});

describe("business MCP tools: invoice drafts", () => {
  it("creates and edits a draft with server-computed totals", async () => {
    const { client } = await startHarness();

    const { invoice } = await ok<{ invoice: InvoiceShape }>(client, "create_invoice_draft", {
      clientId: "client-1",
      number: "INV-1001",
      lineItems: [
        { description: "Hedge trim", quantity: 2, unitPrice: 150 },
        { description: "Green waste removal", quantity: 1, unitPrice: 80 },
      ],
      taxRate: 0.1,
      duplicateKey: "inv-1001",
    });
    assert.equal(invoice.status, "draft");
    assert.equal(invoice.subtotal, 380);
    assert.equal(invoice.total, invoice.subtotal + invoice.tax);
    assert.ok(invoice.tax > 0, "tax is computed by the server, not the caller");

    const updated = await ok<{ invoice: InvoiceShape }>(client, "update_invoice_draft", {
      invoiceId: invoice.id,
      notes: "Payment within 14 days",
    });
    assert.equal(updated.invoice.notes, "Payment within 14 days");
    assert.equal(updated.invoice.status, "draft");

    const drafts = await ok<{ count: number }>(client, "list_invoices", { status: "draft" });
    assert.equal(drafts.count, 1);
    const issued = await ok<{ count: number }>(client, "list_invoices", { status: "issued" });
    assert.equal(issued.count, 0);

    const fetched = await ok<{ invoice: InvoiceShape }>(client, "get_invoice", {
      invoiceId: invoice.id,
    });
    assert.equal(fetched.invoice.number, "INV-1001");
  });

  it("refuses negative amounts, empty updates and unknown invoices", async () => {
    const { client } = await startHarness();
    await refused(client, "create_invoice_draft", {
      clientId: "client-1",
      number: "INV-1",
      lineItems: [{ description: "Bad", quantity: 1, unitPrice: -5 }],
    });
    await refused(client, "update_invoice_draft", { invoiceId: "missing" }, /requires/i);
    await refused(client, "get_invoice", { invoiceId: "missing" }, /not found/i);
    const { count } = await ok<{ count: number }>(client, "list_invoices");
    assert.equal(count, 0);
  });
});

describe("business MCP tools: authority boundary", () => {
  it("exposes drafting only: no invoice issue, void or payment, and no quote writes", async () => {
    const { client } = await startHarness();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of names) {
      assert.doesNotMatch(
        name,
        /issue|void|payment|review|finali[sz]e|reopen|fork|outcome|deliver|send/i,
        `MCP tool ${name} reaches beyond drafting`,
      );
      // The quote lifecycle contract keeps quote writes off MCP; only list/get remain.
      if (/quote/.test(name)) assert.ok(["list_quotes", "get_quote"].includes(name), name);
    }
  });

  it("marks reads read-only, deletes destructive, and creates non-idempotent", async () => {
    const { client } = await startHarness();
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const reads = [
      "list_properties",
      "get_property",
      "list_enquiries",
      "get_enquiry",
      "list_invoices",
      "get_invoice",
    ];
    for (const name of reads) {
      assert.equal(tools.get(name)?.annotations?.readOnlyHint, true, `${name} is read-only`);
      assert.equal(tools.get(name)?.annotations?.destructiveHint, false, `${name} is safe`);
    }
    assert.equal(tools.get("delete_property")?.annotations?.destructiveHint, true);
    for (const name of [
      "create_property",
      "create_enquiry",
      "create_invoice_draft",
      "convert_enquiry_to_project",
    ]) {
      assert.equal(tools.get(name)?.annotations?.readOnlyHint, false, `${name} writes`);
      assert.equal(tools.get(name)?.annotations?.idempotentHint, false, `${name} is not a no-op`);
      assert.equal(tools.get(name)?.annotations?.openWorldHint, false, `${name} stays inside`);
    }
  });
});
