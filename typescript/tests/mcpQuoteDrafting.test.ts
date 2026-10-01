import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";

/** A draft revision-1 snapshot, as the Convex lifecycle returns from create. */
const DRAFT: QuoteSnapshot = {
  aggregate: {
    quoteId: "quote-301",
    ownerId: "owner-1",
    clientId: "client-1",
    projectId: "project-9",
    number: "301",
    currentRevision: 1,
    currentRevisionId: "rev-1",
    aggregateVersion: 1,
    commercialStatus: "open",
    createdAt: 100,
    updatedAt: 100,
  },
  revision: {
    revisionId: "rev-1",
    ownerId: "owner-1",
    quoteId: "quote-301",
    revision: 1,
    revisionVersion: 1,
    status: "draft",
    lineItems: [{ description: "Crown reduction", quantity: 1, unitPrice: 450 }],
    subtotal: 450,
    tax: 0,
    total: 450,
    currency: "AUD",
    termsIncluded: true,
    fingerprint: "quote-revision:v1:sha256:draft",
    createdAt: 100,
    updatedAt: 100,
  },
};

/** The same draft after an edit: a note added and the revision version bumped. */
const EDITED: QuoteSnapshot = {
  aggregate: { ...DRAFT.aggregate, aggregateVersion: 2, updatedAt: 200 },
  revision: {
    ...DRAFT.revision,
    revisionVersion: 2,
    notes: "Access via rear lane.",
    updatedAt: 200,
  },
};

type RecordedRequest = { method: string; path: string; body: unknown };

function stubClient(sink: RecordedRequest[]): JarvisApiClient {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    sink.push({ method, path, body });
    if (path === "/api/v1/quotes" && method === "POST") {
      return Response.json({ data: DRAFT }, { status: 201 });
    }
    if (path === "/api/v1/quotes/quote-301/revisions/1" && method === "PATCH") {
      return Response.json({ data: EDITED });
    }
    return Response.json({ title: "Not Found", status: 404 }, { status: 404 });
  }) as typeof fetch;
  return new JarvisApiClient(
    { baseUrl: new URL("https://jarvis.example/"), serviceToken: "quote-drafting-test-token" },
    fetchImpl,
  );
}

async function withMcp(client: JarvisApiClient, run: (c: Client) => Promise<void>): Promise<void> {
  const server = createJarvisMcpServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "quote-drafting-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  try {
    await run(mcp);
  } finally {
    await mcp.close();
    await server.close();
  }
}

describe("MCP quote drafting", () => {
  it("registers draft create/edit tools as non-idempotent writes, not finalize or send", async () => {
    await withMcp(stubClient([]), async (mcp) => {
      const tools = (await mcp.listTools()).tools;
      const create = tools.find((tool) => tool.name === "create_quote_draft");
      const update = tools.find((tool) => tool.name === "update_quote_draft");

      assert.ok(create, "create_quote_draft should be exposed");
      assert.ok(update, "update_quote_draft should be exposed");
      for (const tool of [create, update]) {
        assert.equal(tool.annotations?.readOnlyHint, false);
        assert.equal(tool.annotations?.destructiveHint, false);
        assert.equal(tool.annotations?.idempotentHint, false);
      }

      // Drafting only: the lifecycle steps that dispatch or freeze records stay off MCP.
      for (const forbidden of [
        "finalize_quote",
        "send_quote",
        "review_quote",
        "submit_quote_for_review",
        "fork_quote",
        "record_quote_commercial_outcome",
      ]) {
        assert.equal(
          tools.some((tool) => tool.name === forbidden),
          false,
          `${forbidden} must not be exposed`,
        );
      }
    });
  });

  it("creates a draft quote through the documented POST route", async () => {
    const requests: RecordedRequest[] = [];
    await withMcp(stubClient(requests), async (mcp) => {
      const result = await mcp.callTool({
        name: "create_quote_draft",
        arguments: {
          clientId: "client-1",
          number: "301",
          termsIncluded: true,
          projectId: "project-9",
          lineItems: [{ description: "Crown reduction", quantity: 1, unitPrice: 450 }],
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { quote: DRAFT });
    });
    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/api/v1/quotes",
        body: {
          clientId: "client-1",
          number: "301",
          termsIncluded: true,
          projectId: "project-9",
          lineItems: [{ description: "Crown reduction", quantity: 1, unitPrice: 450 }],
        },
      },
    ]);
  });

  it("edits a draft under optimistic concurrency through the revision PATCH route", async () => {
    const requests: RecordedRequest[] = [];
    await withMcp(stubClient(requests), async (mcp) => {
      const result = await mcp.callTool({
        name: "update_quote_draft",
        arguments: {
          quoteId: "quote-301",
          revision: 1,
          expectedAggregateVersion: 1,
          expectedRevisionVersion: 1,
          patch: { notes: "Access via rear lane." },
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { quote: EDITED });
    });
    assert.deepEqual(requests, [
      {
        method: "PATCH",
        path: "/api/v1/quotes/quote-301/revisions/1",
        body: {
          expectedAggregateVersion: 1,
          expectedRevisionVersion: 1,
          patch: { notes: "Access via rear lane." },
        },
      },
    ]);
  });

  it("refuses an empty draft patch without calling the server", async () => {
    const requests: RecordedRequest[] = [];
    await withMcp(stubClient(requests), async (mcp) => {
      const result = await mcp.callTool({
        name: "update_quote_draft",
        arguments: {
          quoteId: "quote-301",
          revision: 1,
          expectedAggregateVersion: 1,
          expectedRevisionVersion: 1,
          patch: {},
        },
      });
      assert.equal(result.isError, true);
    });
    assert.deepEqual(requests, []);
  });

  it("surfaces the 503 when the Convex quote lifecycle is unavailable", async () => {
    const fetchImpl = (async () =>
      Response.json(
        {
          type: "urn:jarvis:problem:quote-lifecycle-unavailable",
          title: "Quote Lifecycle Unavailable",
          status: 503,
        },
        { status: 503 },
      )) as typeof fetch;
    const client = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "quote-drafting-test-token" },
      fetchImpl,
    );
    await withMcp(client, async (mcp) => {
      const result = await mcp.callTool({
        name: "create_quote_draft",
        arguments: {
          clientId: "client-1",
          number: "301",
          termsIncluded: true,
          lineItems: [{ description: "Crown reduction", quantity: 1, unitPrice: 450 }],
        },
      });
      assert.equal(result.isError, true);
    });
  });
});
