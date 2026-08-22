import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DailyBrief } from "../src/briefs/brief.js";
import type { SystemStatus } from "../src/http/contracts.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import type { QuoteSummary } from "../src/quotes/quoteRepository.js";

const STATUS: SystemStatus = {
  status: "ok",
  version: "0.1.0",
  sourceVersion: "dashboard-projection-test",
  provider: {
    name: "json",
    reachability: "ok",
    authentication: "not-required",
    schemaCompatibility: "compatible",
    deploymentVersion: null,
  },
  reconciliation: { state: "disabled", enabled: false },
  integrations: [],
  timezone: "Australia/Melbourne",
  layers: {
    runtime: { status: "ready" },
    domains: { status: "ready" },
    integration: { status: "ready" },
    orchestration: { status: "ready" },
    safety: { status: "ready" },
    adaptive: { status: "ready" },
    autonomy: { status: "ready" },
    reliability: { status: "ready" },
  },
  zState: "active",
  checkedAt: "2026-07-30T00:00:00.000Z",
};

const TASK = {
  id: "task-1",
  title: "Prepare Marilyn quote",
  completed: false,
  category: "work",
  createdAt: 1,
};

const REMINDER = {
  id: "reminder-1",
  title: "Chase supplier",
  dueRaw: "Friday 9am",
  createdAt: 1,
};

const LIFECYCLE_QUOTE: QuoteSummary = {
  quoteId: "lifecycle-quote-174",
  clientId: "client-1",
  projectId: "project-1",
  number: "174",
  currentRevision: 2,
  aggregateVersion: 4,
  revisionStatus: "finalized",
  commercialStatus: "open",
  total: 3200.5,
  currency: "AUD",
  updatedAt: 3,
};

const BRIEF: DailyBrief = {
  generatedAt: "2026-07-30T00:00:00.000Z",
  timezone: "Australia/Melbourne",
  headline: "1 open task, 0 reminders due, 1 active project, 1 quote awaiting response.",
  tasks: { openCount: 1, completedCount: 0, open: [TASK] },
  reminders: { dueCount: 0, upcomingCount: 0, undatedCount: 1, due: [], upcoming: [] },
  projects: {
    activeCount: 1,
    countsByStatus: { lead: 0, quoted: 0, active: 1, on_hold: 0, done: 0 },
    active: [
      {
        id: "project-1",
        clientId: "client-1",
        title: "Frankston garden rebuild",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  },
  quotes: {
    countsByStatus: { draft: 1, sent: 1, accepted: 0, declined: 0 },
    pipelineTotal: 3200,
    acceptedTotal: 0,
    awaitingResponse: [
      {
        id: "quote-1",
        clientId: "client-1",
        projectId: "project-1",
        number: "174",
        status: "sent",
        lineItems: [{ description: "Garden works", quantity: 1, unitPrice: 3200 }],
        subtotal: 3200,
        tax: 0,
        total: 3200,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    drafts: [],
  },
  maintenance: { dueCount: 0, dueSoonCount: 0, due: [], dueSoon: [] },
};

const INBOX = { generatedAt: "2026-07-30T00:00:00.000Z", items: [], sources: [] };
const ACTIVITY = { status: "available", events: [], cursor: "", isDone: true };

describe("dashboard snapshot", () => {
  it("projects the daily brief through the existing authenticated dashboard read", async () => {
    const paths: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
      if (url.pathname === "/api/v1/status") return Response.json(STATUS);
      if (url.pathname === "/api/v1/tasks") return Response.json({ data: [TASK], count: 1 });
      if (url.pathname === "/api/v1/reminders")
        return Response.json({ data: [REMINDER], count: 1 });
      if (url.pathname === "/api/v1/brief") return Response.json({ data: BRIEF });
      if (url.pathname === "/api/v1/quotes")
        return Response.json({ data: [LIFECYCLE_QUOTE], count: 1 });
      if (url.pathname === "/api/v1/operations/inbox") return Response.json({ data: INBOX });
      if (url.pathname === "/api/v1/operations/activity") return Response.json({ data: ACTIVITY });
      if (url.pathname === "/api/v1/clients") return Response.json({ data: [], count: 0 });
      if (url.pathname === "/api/v1/properties") return Response.json({ data: [], count: 0 });
      if (url.pathname === "/api/v1/enquiries") return Response.json({ data: [], count: 0 });
      if (url.pathname === "/api/v1/invoices") return Response.json({ data: [], count: 0 });
      if (url.pathname === "/api/v1/projects/project-1/tool-actions") return Response.json([]);
      if (url.pathname === "/api/v1/reconciliations") return Response.json({ data: [], count: 0 });
      return Response.json({ title: "Not Found" }, { status: 404 });
    }) as typeof fetch;

    const client = new JarvisApiClient(
      { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "test-token" },
      fetchImpl,
    );

    const snapshot = await client.dashboard();

    assert.deepEqual(paths.sort(), [
      "/api/v1/brief",
      "/api/v1/clients",
      "/api/v1/enquiries",
      "/api/v1/invoices",
      "/api/v1/operations/activity",
      "/api/v1/operations/inbox",
      "/api/v1/projects/project-1/tool-actions",
      "/api/v1/properties",
      "/api/v1/quotes",
      "/api/v1/reconciliations",
      "/api/v1/reminders",
      "/api/v1/status",
      "/api/v1/tasks",
    ]);
    assert.deepEqual(snapshot.brief, BRIEF);
    assert.deepEqual(snapshot.quoteRegister, {
      status: "ready",
      quotes: [LIFECYCLE_QUOTE],
    });
    assert.deepEqual(snapshot.inbox, INBOX);
    assert.deepEqual(snapshot.activity, ACTIVITY);
    assert.notEqual(
      snapshot.quoteRegister.quotes[0]?.quoteId,
      snapshot.brief.quotes.awaitingResponse[0]?.id,
    );
    assert.deepEqual(snapshot.counts, { activeTasks: 1, completedTasks: 0, reminders: 1 });
    assert.equal(snapshot.presence, "idle");
    assert.deepEqual(snapshot.approvals, { status: "ready", items: [] });
    assert.deepEqual(snapshot.reconciliations, { status: "ready", items: [] });
    assert.equal(snapshot.business.enquiries.status, "ready");
    assert.equal(snapshot.business.invoices.status, "ready");
  });
  it("degrades only the quote register when lifecycle reads are unavailable", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/status") return Response.json(STATUS);
      if (path === "/api/v1/tasks") return Response.json({ data: [TASK], count: 1 });
      if (path === "/api/v1/reminders") return Response.json({ data: [REMINDER], count: 1 });
      if (path === "/api/v1/brief") return Response.json({ data: BRIEF });
      if (path === "/api/v1/quotes") {
        return Response.json(
          {
            type: "urn:jarvis:problem:quote-lifecycle-unavailable",
            title: "Quote Lifecycle Unavailable",
            status: 503,
          },
          { status: 503 },
        );
      }
      return Response.json({ title: "Not Found" }, { status: 404 });
    }) as typeof fetch;
    const client = new JarvisApiClient(
      { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "test-token" },
      fetchImpl,
    );

    const snapshot = await client.dashboard();

    assert.deepEqual(snapshot.quoteRegister, { status: "unavailable", quotes: [] });
    assert.deepEqual(snapshot.tasks, [TASK]);
    assert.deepEqual(snapshot.brief, BRIEF);
    // The inbox/activity endpoints 404 in this fixture (unhandled paths) —
    // that must degrade to null, never fail the whole dashboard read.
    assert.equal(snapshot.inbox, null);
    assert.equal(snapshot.activity, null);
    assert.deepEqual(snapshot.reconciliations, { status: "unavailable", items: [] });
  });
});
