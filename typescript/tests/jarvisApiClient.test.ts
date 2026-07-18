import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SystemStatus } from "../src/http/contracts.js";
import { JarvisApiClient, JarvisApiError } from "../src/mcp/jarvisApiClient.js";

const STATUS: SystemStatus = {
  status: "ok",
  version: "0.1.0",
  sourceVersion: "abcdef123",
  provider: {
    name: "convex",
    reachability: "ok",
    authentication: "ok",
    schemaCompatibility: "compatible",
    deploymentVersion: "dev:outgoing-ram-798",
  },
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
  checkedAt: "2026-07-18T11:00:00.000Z",
};

describe("Jarvis MCP REST client", () => {
  it("injects the service token server-side", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify(STATUS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new JarvisApiClient(
      { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "secret-token" },
      fetchImpl,
    );
    const status = await client.getStatus();

    assert.equal(capturedUrl, "http://127.0.0.1:3000/api/v1/status");
    const headers = capturedHeaders as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret-token");
    assert.match(headers["X-Request-Id"], /^mcp-/);
    assert.equal(status.provider.name, "convex");
  });

  it("uses a unique safe idempotency key when creating a task", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          data: {
            id: "task-1",
            title: "Check preview",
            completed: false,
            category: "builds",
            createdAt: 1,
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new JarvisApiClient(
      { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "secret-token" },
      fetchImpl,
    );

    await client.createTask("Check preview", "builds");

    const headers = capturedInit?.headers as Record<string, string>;
    assert.match(headers["Idempotency-Key"], /^mcp-[A-Za-z0-9-]{36}$/);
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      title: "Check preview",
      category: "builds",
    });
  });

  it("returns safe Jarvis problem details without raw response leakage", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:jarvis:problem:task-not-found",
          title: "Task Not Found",
          status: 404,
          detail: "The requested task does not exist.",
          requestId: "request-safe-1",
          internal: "must not be surfaced",
        }),
        { status: 404, headers: { "Content-Type": "application/problem+json" } },
      )) as typeof fetch;
    const client = new JarvisApiClient(
      { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "secret-token" },
      fetchImpl,
    );

    await assert.rejects(
      () => client.getTask("missing"),
      (error: unknown) =>
        error instanceof JarvisApiError &&
        error.status === 404 &&
        error.problemType === "urn:jarvis:problem:task-not-found" &&
        error.requestId === "request-safe-1" &&
        !error.message.includes("must not be surfaced"),
    );
  });

  it("builds dashboard counts from live status, tasks and reminders", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/status") return Response.json(STATUS);
      if (path === "/api/v1/tasks") {
        return Response.json({
          data: [
            { id: "1", title: "One", completed: false, category: "work", createdAt: 1 },
            { id: "2", title: "Two", completed: true, category: "work", createdAt: 2 },
          ],
          count: 2,
        });
      }
      return Response.json({
        data: [{ id: "r1", title: "Call Claire", dueRaw: "Friday 9am", createdAt: 1 }],
        count: 1,
      });
    }) as typeof fetch;
    const client = new JarvisApiClient(
      { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "secret-token" },
      fetchImpl,
    );

    const dashboard = await client.dashboard();
    assert.deepEqual(dashboard.counts, {
      activeTasks: 1,
      completedTasks: 1,
      reminders: 1,
    });
  });
});
