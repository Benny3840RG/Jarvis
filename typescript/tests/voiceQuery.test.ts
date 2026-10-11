import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import {
  DisconnectedQueryProvider,
  NO_QUERY_PROVIDER_REASON,
  type VoiceQueryProvider,
  type VoiceQueryResult,
} from "../src/voice/voiceQuery.js";
import { VoiceSession } from "../src/voice/voiceSession.js";
import { VoiceSessionRegistry } from "../src/voice/voiceSessionRegistry.js";

function clientSession(queryProvider?: VoiceQueryProvider): VoiceSession {
  return new VoiceSession({
    profile: "client",
    provider: new AbsentHardwareProvider(),
    ...(queryProvider ? { queryProvider } : {}),
  });
}

/** A deterministic provider that returns a fixed result for every query. */
function stubProvider(result: (commandId: string) => VoiceQueryResult): VoiceQueryProvider {
  return {
    async answer(request) {
      return result(request.commandId);
    },
  };
}

describe("DisconnectedQueryProvider", () => {
  it("reports every query unavailable and never answers", async () => {
    const provider = new DisconnectedQueryProvider();
    const result = await provider.answer({ commandId: "client.unpaid-invoices", profile: "client" });
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert.equal(result.commandId, "client.unpaid-invoices");
      assert.equal(result.reason, NO_QUERY_PROVIDER_REASON);
    }
  });
});

describe("voice session — read-only query dispatch (#567 Stage 3)", () => {
  it("fails closed as unavailable by default, with no provider connected", async () => {
    const d = await clientSession().handle({
      transcript: "any unpaid invoices",
      isFinal: true,
      now: 0,
    });
    assert.equal(d.decision, "query-unavailable");
    if (d.decision === "query-unavailable") {
      assert.equal(d.command.id, "client.unpaid-invoices");
      assert.equal(d.reason, NO_QUERY_PROVIDER_REASON);
    }
  });

  it("answers from a connected provider and passes the command id and profile", async () => {
    const seen: Array<{ commandId: string; profile: string }> = [];
    const provider: VoiceQueryProvider = {
      async answer(request) {
        seen.push({ commandId: request.commandId, profile: request.profile });
        return { status: "answered", commandId: request.commandId, answer: "Two unpaid invoices." };
      },
    };
    const d = await clientSession(provider).handle({
      transcript: "any unpaid invoices",
      isFinal: true,
      now: 0,
    });
    assert.equal(d.decision, "query-answered");
    if (d.decision === "query-answered") {
      assert.equal(d.command.id, "client.unpaid-invoices");
      assert.equal(d.answer, "Two unpaid invoices.");
    }
    assert.deepEqual(seen, [{ commandId: "client.unpaid-invoices", profile: "client" }]);
  });

  it("surfaces an unavailable read model as query-unavailable with the provider's reason", async () => {
    const provider = stubProvider((commandId) => ({
      status: "unavailable",
      commandId,
      reason: "The invoice read model is not configured.",
    }));
    const d = await clientSession(provider).handle({
      transcript: "any unpaid invoices",
      isFinal: true,
      now: 0,
    });
    assert.equal(d.decision, "query-unavailable");
    if (d.decision === "query-unavailable") {
      assert.equal(d.reason, "The invoice read model is not configured.");
    }
  });

  it("surfaces a provider read failure as query-failed, not an answer", async () => {
    const provider = stubProvider((commandId) => ({
      status: "failed",
      commandId,
      reason: "The invoice read failed.",
    }));
    const d = await clientSession(provider).handle({
      transcript: "any unpaid invoices",
      isFinal: true,
      now: 0,
    });
    assert.equal(d.decision, "query-failed");
    if (d.decision === "query-failed") {
      assert.equal(d.reason, "The invoice read failed.");
    }
  });

  it("fails closed when the provider throws (never reads as an answer)", async () => {
    const provider: VoiceQueryProvider = {
      async answer() {
        throw new Error("boom");
      },
    };
    const d = await clientSession(provider).handle({
      transcript: "any unpaid invoices",
      isFinal: true,
      now: 0,
    });
    assert.equal(d.decision, "query-failed");
    if (d.decision === "query-failed") {
      assert.match(d.reason, /failed closed/);
    }
  });
});

describe("VoiceSessionRegistry — query provider wiring", () => {
  it("threads a shared query provider into every created session", async () => {
    const calls: string[] = [];
    const provider: VoiceQueryProvider = {
      async answer(request) {
        calls.push(request.commandId);
        return { status: "answered", commandId: request.commandId, answer: "ok" };
      },
    };
    const registry = new VoiceSessionRegistry({
      provider: new AbsentHardwareProvider(),
      queryProvider: provider,
    });
    const created = registry.create("client");
    const session = registry.get(created.id);
    assert.ok(session);
    const d = await session.handle({ transcript: "any unpaid invoices", isFinal: true, now: 0 });
    assert.equal(d.decision, "query-answered");
    assert.deepEqual(calls, ["client.unpaid-invoices"]);
  });

  it("defaults to the disconnected provider when none is supplied", async () => {
    const registry = new VoiceSessionRegistry({ provider: new AbsentHardwareProvider() });
    const created = registry.create("client");
    const session = registry.get(created.id);
    assert.ok(session);
    const d = await session.handle({ transcript: "any unpaid invoices", isFinal: true, now: 0 });
    assert.equal(d.decision, "query-unavailable");
  });
});
