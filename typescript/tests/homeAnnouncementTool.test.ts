import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHomeAnnouncementToolDefinition,
  homeAnnouncementArgumentsSchema,
} from "../src/actions/homeAnnouncementTool.js";
import {
  createGoogleHomeAnnouncementProviderFromEnv,
  type GoogleHomeAnnouncementAttempt,
  type GoogleHomeAnnouncementInput,
  type GoogleHomeAnnouncementProvider,
} from "../src/integrations/googleHome/googleHomeAnnouncementProvider.js";
import type { ToolExecutionContext } from "../src/actions/toolExecution.js";

function context(registrations: Array<Record<string, string>>): ToolExecutionContext {
  return {
    action: {
      actionId: "action-1",
      requestId: "request-1",
      projectId: "project-1",
      tool: "home",
      operation: "announce",
      baseRevision: 1,
      state: "approved",
      arguments: {},
      rationale: "test announcement",
      requiredAuthority: "T1",
      destructive: false,
      idempotencyKey: "idem-1",
      proposedBy: "user",
      consumptionPolicy: "single-use",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    idempotencyKey: "idem-1",
    actionFingerprint: "action-fp",
    effectFingerprint: "effect-fp",
    correlationId: "corr-1",
    source: "test",
    policyVersion: "test",
    async registerProviderAttempt(reference): Promise<void> {
      registrations.push({ ...reference });
    },
  };
}

describe("home announcement tool", () => {
  it("registers the provider attempt before emitting audio", async () => {
    const order: string[] = [];
    const provider: GoogleHomeAnnouncementProvider = {
      name: "google-home-notifier-v1",
      async discover() {
        return [{ name: "Kitchen display", address: "192.0.2.1", port: 8009 }];
      },
      async prepare(input: GoogleHomeAnnouncementInput): Promise<GoogleHomeAnnouncementAttempt> {
        order.push("prepare");
        return {
          providerRequestId: "attempt-1",
          providerCorrelationId: "corr-1",
          target: input.target,
          address: "192.0.2.1",
        };
      },
      async sendPrepared() {
        order.push("send");
        return { target: "Kitchen display", result: "announced" };
      },
    };
    const registrations: Array<Record<string, string>> = [];
    const definition = createHomeAnnouncementToolDefinition(provider);
    const ctx = context(registrations);

    await definition.execute(
      { target: "Kitchen display", message: "NOLAN reporting for duty." },
      new AbortController().signal,
      {
        ...ctx,
        async registerProviderAttempt(reference) {
          order.push("register");
          await ctx.registerProviderAttempt(reference);
        },
      },
    );

    assert.deepEqual(order, ["prepare", "register", "send"]);
    assert.equal(definition.minimumAuthority, "T1");
    assert.deepEqual(registrations, [
      {
        provider: "google-home-notifier-v1",
        providerRequestId: "attempt-1",
        providerCorrelationId: "corr-1",
      },
    ]);
  });

  it("rejects oversized announcements and unsafe volume", () => {
    assert.equal(
      homeAnnouncementArgumentsSchema.safeParse({
        target: "Kitchen display",
        message: "x".repeat(201),
      }).success,
      false,
    );
    assert.equal(
      homeAnnouncementArgumentsSchema.safeParse({
        target: "Kitchen display",
        message: "hello",
        volume: 1,
      }).success,
      false,
    );
  });

  it("rejects invalid pinned target addresses", () => {
    assert.throws(
      () =>
        createGoogleHomeAnnouncementProviderFromEnv({
          JARVIS_GOOGLE_HOME_TARGETS_JSON: '{"Kitchen Display":"999.1.1.1"}',
        }),
      /target-map-invalid/,
    );
  });

  it("does not send when provider preparation fails", async () => {
    let sent = false;
    const provider: GoogleHomeAnnouncementProvider = {
      name: "google-home-notifier-v1",
      async discover() {
        return [];
      },
      async prepare() {
        throw new Error("google-home-target-not-allowlisted");
      },
      async sendPrepared() {
        sent = true;
        return { target: "x", result: "announced" };
      },
    };
    const definition = createHomeAnnouncementToolDefinition(provider);
    await assert.rejects(
      definition.execute(
        { target: "Kitchen display", message: "hello" },
        new AbortController().signal,
        context([]),
      ),
      /not-allowlisted/,
    );
    assert.equal(sent, false);
  });
});
