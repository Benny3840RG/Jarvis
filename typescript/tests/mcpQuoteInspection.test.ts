import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";
import type { QuoteSummary } from "../src/quotes/quoteRepository.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";

const SUMMARY: QuoteSummary = {
  quoteId: "quote / 174",
  clientId: "client-1",
  projectId: "project-1",
  number: "174",
  currentRevision: 2,
  aggregateVersion: 4,
  revisionStatus: "finalized",
  commercialStatus: "open",
  total: 3200.5,
  currency: "AUD",
  updatedAt: 20,
};

const SNAPSHOT: QuoteSnapshot = {
  aggregate: {
    quoteId: "quote / 174",
    ownerId: "owner-1",
    clientId: "client-1",
    projectId: "project-1",
    number: "174",
    currentRevision: 2,
    currentRevisionId: "revision-2",
    aggregateVersion: 4,
    commercialStatus: "open",
    createdAt: 10,
    updatedAt: 20,
  },
  revision: {
    revisionId: "revision-2",
    ownerId: "owner-1",
    quoteId: "quote / 174",
    revision: 2,
    revisionVersion: 3,
    status: "finalized",
    lineItems: [
      { description: "Garden preparation", quantity: 1, unitPrice: 1200.25 },
      { description: "PebbleLock installation", quantity: 1, unitPrice: 2000.25 },
    ],
    subtotal: 3200.5,
    tax: 0,
    total: 3200.5,
    currency: "AUD",
    validUntil: "2026-08-30",
    notes: "Read-only inspection fixture.",
    termsIncluded: true,
    fingerprint: "quote-revision:v1:sha256:fixture",
    finalizedAt: 19,
    createdAt: 10,
    updatedAt: 20,
  },
};

describe("MCP quote inspection", () => {
  it("reads quote summaries and one lifecycle snapshot", async () => {
    const paths: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/api/v1/quotes") return Response.json({ data: [SUMMARY], count: 1 });
      if (path === "/api/v1/quotes/quote%20%2F%20174") {
        return Response.json({ data: SNAPSHOT });
      }
      return Response.json({ title: "Not Found", status: 404 }, { status: 404 });
    }) as typeof fetch;
    const client = new JarvisApiClient(
      {
        baseUrl: new URL("https://jarvis.example/"),
        serviceToken: "quote-inspection-test-token",
      },
      fetchImpl,
    );

    const summaries = await client.listQuotes();
    const snapshot = await client.getQuote("quote / 174");

    assert.deepEqual(summaries, [SUMMARY]);
    assert.deepEqual(snapshot, SNAPSHOT);
    assert.deepEqual(paths, ["/api/v1/quotes", "/api/v1/quotes/quote%20%2F%20174"]);
  });


  it("exposes quote inspection as read-only MCP tools", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/quotes") return Response.json({ data: [SUMMARY], count: 1 });
      if (path === "/api/v1/quotes/quote%20%2F%20174") {
        return Response.json({ data: SNAPSHOT });
      }
      return Response.json({ title: "Not Found", status: 404 }, { status: 404 });
    }) as typeof fetch;
    const apiClient = new JarvisApiClient(
      {
        baseUrl: new URL("https://jarvis.example/"),
        serviceToken: "quote-inspection-test-token",
      },
      fetchImpl,
    );
    const server = createJarvisMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "quote-inspection-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const catalogue = await client.listTools();
      const listTool = catalogue.tools.find((tool) => tool.name === "list_quotes");
      const getTool = catalogue.tools.find((tool) => tool.name === "get_quote");

      assert.ok(listTool);
      assert.ok(getTool);
      for (const tool of [listTool, getTool]) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
      }
      assert.equal(catalogue.tools.some((tool) => /^finalize_quote|^send_quote/.test(tool.name)), false);

      const listed = await client.callTool({ name: "list_quotes", arguments: {} });
      assert.equal(listed.isError, undefined);
      assert.deepEqual(listed.structuredContent, { quotes: [SUMMARY], count: 1 });

      const inspected = await client.callTool({
        name: "get_quote",
        arguments: { quoteId: "quote / 174" },
      });
      assert.equal(inspected.isError, undefined);
      assert.deepEqual(inspected.structuredContent, { quote: SNAPSHOT });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
