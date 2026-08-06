import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DomainRegistry,
  EventBus,
  ToolGateway,
  createRuntimeIntegrationCore,
} from "../src/runtime/integrationCore.js";

describe("runtime integration core", () => {
  it("publishes ordered events and supports unsubscribe", async () => {
    const events = new EventBus();
    const received: number[] = [];
    const unsubscribe = events.subscribe("test.event", (event) => {
      received.push(event.sequence);
    });

    await events.publish("test.event", { safe: true }, "corr-1");
    unsubscribe();
    await events.publish("test.event", { safe: false }, "corr-1");

    assert.deepEqual(received, [1]);
  });

  it("isolates listener failures and publishes a deterministic failure event", async () => {
    const events = new EventBus();
    const failures: unknown[] = [];
    events.subscribe("test.event", () => {
      throw new Error("listener broke");
    });
    events.subscribe("runtime.listener.failed", (event) => {
      failures.push(event.payload);
    });

    const published = await events.publish("test.event", {}, "corr-2");

    assert.equal(published.sequence, 1);
    assert.deepEqual(events.failures(), [
      { eventSequence: 1, eventType: "test.event", message: "listener broke" },
    ]);
    assert.deepEqual(failures, [{ eventSequence: 1, eventType: "test.event", failureCount: 1 }]);
  });

  it("rejects duplicate and unknown domain registrations", () => {
    const domains = new DomainRegistry();
    domains.register("workshop", async () => "ok");
    assert.throws(
      () => domains.register("workshop", async () => "duplicate"),
      /already registered/,
    );
    assert.equal(domains.has(" workshop "), true);
    assert.equal(domains.resolve(" workshop "), domains.resolve("workshop"));
    assert.throws(() => domains.resolve("home"), /Unknown domain/);
    const listed = domains.list();
    assert.deepEqual(listed, ["workshop"]);
    assert.throws(() => (listed as string[]).push("home"), TypeError);
  });

  it("rejects duplicate tool registrations", () => {
    const tools = new ToolGateway();
    tools.register("notes", "create", async () => "created");
    assert.throws(
      () => tools.register("notes", "create", async () => "duplicate"),
      /already registered/,
    );
    assert.throws(() => tools.register("", "create", async () => "invalid"), /required/);
  });

  it("routes tools and domains through one correlation-aware boundary", async () => {
    const core = createRuntimeIntegrationCore();
    const failures: unknown[] = [];
    core.events.subscribe("runtime.route.failed", (event) => {
      failures.push(event.payload);
    });
    core.domains.register("workshop", async (action, payload) => ({
      kind: "domain",
      action,
      payload,
    }));
    core.tools.register("notes", "create", async (payload, context) => ({
      kind: "tool",
      payload,
      correlationId: context.correlationId,
    }));

    const domainOutput = await core.router.route(
      "workshop",
      "prepare",
      "domain-secret",
      "corr-domain",
    );
    const toolOutput = await core.router.route("notes", "create", "tool-secret", "corr-tool");

    assert.deepEqual(domainOutput, { kind: "domain", action: "prepare", payload: "domain-secret" });
    assert.deepEqual(toolOutput, {
      kind: "tool",
      payload: "tool-secret",
      correlationId: "corr-tool",
    });
    await assert.rejects(() => core.router.route("missing", "route", {}), /Unknown domain/);
    assert.deepEqual(failures, [{ route: "missing:route", errorCode: "route-unavailable" }]);

    const domainLinks = core.memory.list("corr-domain");
    assert.deepEqual(
      domainLinks.map((link) => link.status),
      ["started", "completed"],
    );
    assert.equal(JSON.stringify(domainLinks).includes("domain-secret"), false);
    assert.equal(JSON.stringify(domainLinks).includes("tool-secret"), false);
    assert.equal(domainLinks[0]?.route, "workshop:prepare");

    const firstEvent = await core.events.publish("manual", { ignored: "payload" }, "corr-manual");
    core.memory.link(firstEvent, "manual:link", "started");
    core.memory.link(firstEvent, "manual:link", "started");
    assert.equal(core.memory.list("corr-manual").length, 1);
  });

  it("persists each emitted event before dispatching listeners when a sink is configured", async () => {
    const persisted: string[] = [];
    const core = createRuntimeIntegrationCore({
      sink: {
        async append(event) {
          persisted.push(event.id);
        },
      },
    });
    const dispatched: string[] = [];
    core.events.subscribe("runtime.route.started", (event) => {
      dispatched.push(event.id);
      assert.deepEqual(persisted, [event.id]);
    });
    core.domains.register("runtime", async () => "ok");

    await core.router.route("runtime", "health", {}, "corr-sink");

    assert.equal(persisted.length, 2);
    assert.deepEqual(dispatched, [persisted[0]]);
  });

  it("fails the route before dispatch when durable event append fails", async () => {
    const core = createRuntimeIntegrationCore({
      sink: {
        async append() {
          throw new Error("event-store-offline");
        },
      },
    });
    let dispatched = false;
    core.events.subscribe("runtime.route.started", () => {
      dispatched = true;
    });
    core.domains.register("runtime", async () => "must-not-run");

    await assert.rejects(
      () => core.router.route("runtime", "health", {}, "corr-offline"),
      /event-store-offline/,
    );
    assert.equal(dispatched, false);
  });
});
