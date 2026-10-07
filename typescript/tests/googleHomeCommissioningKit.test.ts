import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { homeAnnouncementArgumentsSchema } from "../src/actions/homeAnnouncementTool.js";
import {
  GOOGLE_HOME_FAIL_CLOSED_TESTS,
  assembleGoogleHomeKitEvidence,
  kitGovernedAnnouncement,
  publicAnnouncementReceipt,
  publicCastDiscovery,
} from "../src/integrations/googleHome/commissioningKit.js";
import {
  LocalGoogleHomeAnnouncementProvider,
  createGoogleHomeAnnouncementProviderFromEnv,
  describeGoogleHomePins,
} from "../src/integrations/googleHome/googleHomeAnnouncementProvider.js";

describe("google home pinned targets", () => {
  it("registers no announcement provider when no target is pinned", () => {
    assert.equal(createGoogleHomeAnnouncementProviderFromEnv({}), null);
    assert.equal(
      createGoogleHomeAnnouncementProviderFromEnv({ JARVIS_GOOGLE_HOME_TARGETS_JSON: "{}" }),
      null,
    );
    assert.deepEqual(describeGoogleHomePins({}), { status: "absent" });
  });

  it("names pinned targets without copying their addresses into the description", () => {
    const description = describeGoogleHomePins({
      JARVIS_GOOGLE_HOME_TARGETS_JSON: '{"Kitchen Display":"192.0.2.20"}',
    });
    assert.deepEqual(description, { status: "pinned", targetNames: ["Kitchen Display"] });
    assert.equal(JSON.stringify(description).includes("192.0.2.20"), false);
  });

  it("rejects a target that is not pinned, including a raw address", async () => {
    const provider = new LocalGoogleHomeAnnouncementProvider(
      new Map([["Kitchen Display", "192.0.2.20"]]),
    );
    await assert.rejects(
      provider.prepare({ target: "192.0.2.50", message: "hello" }),
      /google-home-target-not-allowlisted/,
    );
    await assert.rejects(
      provider.prepare({ target: "Bedroom Hub", message: "hello" }),
      /google-home-target-not-allowlisted/,
    );
    const attempt = await provider.prepare({ target: "Kitchen Display", message: "hello" });
    assert.equal(attempt.address, "192.0.2.20");
    assert.equal(attempt.target, "Kitchen Display");
  });

  it("rejects an address field so a caller cannot choose an arbitrary Cast device", () => {
    assert.equal(
      homeAnnouncementArgumentsSchema.safeParse({
        target: "Kitchen Display",
        message: "hello",
        address: "192.0.2.50",
      }).success,
      false,
    );
  });

  it("fails closed on cancellation before any Cast send", async () => {
    const provider = new LocalGoogleHomeAnnouncementProvider(
      new Map([["Kitchen Display", "192.0.2.20"]]),
    );
    const attempt = await provider.prepare({ target: "Kitchen Display", message: "hello" });
    const started = Date.now();
    await assert.rejects(
      provider.sendPrepared(
        attempt,
        { target: "Kitchen Display", message: "hello" },
        AbortSignal.abort(new Error("announcement-cancelled")),
      ),
      (error: unknown) => error instanceof Error && error.message === "announcement-cancelled",
    );
    assert.ok(Date.now() - started < 1_000);
  });
});

describe("google home kit evidence", () => {
  it("never claims commissioning and does not keep device addresses", () => {
    const discovery = publicCastDiscovery([
      { name: "Kitchen Display", address: "192.0.2.20" } as { name: string },
    ]);
    assert.equal(JSON.stringify(discovery).includes("192.0.2.20"), false);
    const evidence = assembleGoogleHomeKitEvidence({
      generatedAt: "2026-10-07T00:00:00.000Z",
      pins: { status: "absent" },
      discovery: publicCastDiscovery([]),
      tts: { status: "audible", detail: "local-tts-audible" },
      failClosedDrills: { status: "passed", detail: "drills" },
      governedAnnouncement: {
        status: "not-executed",
        reason: "approval withheld",
        receipt: null,
      },
    });
    assert.equal(evidence.commissioningClaimed, false);
    assert.equal(evidence.physicalHostRequired, true);
    assert.equal(evidence.discovery.status, "unavailable");
    assert.ok(GOOGLE_HOME_FAIL_CLOSED_TESTS.includes("tests/localCastCleanup.test.ts"));
    assert.equal(
      publicAnnouncementReceipt({
        receiptId: "receipt-1",
        tool: "home",
        operation: "announce",
        status: "failed",
        errorCode: "provider-failed",
        arguments: { target: "secret" },
      })?.errorCode,
      "provider-failed",
    );
    assert.equal(publicAnnouncementReceipt({ tool: "quotes", operation: "send" }), null);
  });

  it("never posts tool-action execute, whatever environment is set", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response("execute-forbidden", { status: 500 });
    }) as typeof fetch;
    const environments: NodeJS.ProcessEnv[] = [
      {},
      {
        JARVIS_API_BASE_URL: "http://127.0.0.1:3210",
        JARVIS_SERVICE_TOKEN: "service-token",
        JARVIS_HOME_ANNOUNCE_PROJECT_ID: "project-1",
        JARVIS_HOME_ANNOUNCE_ACTION_ID: "approved-home-announce",
      },
      {
        JARVIS_API_BASE_URL: "http://127.0.0.1:3210",
        JARVIS_SERVICE_TOKEN: "service-token",
        JARVIS_HOME_ANNOUNCE_PROJECT_ID: "project-1",
        JARVIS_HOME_ANNOUNCE_ACTION_ID: "quotes-send-action",
      },
      {
        JARVIS_API_BASE_URL: "http://127.0.0.1:3210",
        JARVIS_SERVICE_TOKEN: "service-token",
        JARVIS_HOME_ANNOUNCE_PROJECT_ID: "project-1",
        JARVIS_HOME_ANNOUNCE_ACTION_ID: "approved-home-announce",
        JARVIS_GOOGLE_HOME_TARGETS_JSON: '{"Kitchen Display":"192.0.2.20"}',
      },
    ];
    try {
      for (const env of environments) {
        const result = kitGovernedAnnouncement(env);
        assert.equal(result.status, "not-executed");
        assert.equal(result.receipt, null);
      }
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(calls, []);

    const runnerSource = readFileSync(
      fileURLToPath(new URL("../src/tools/runGoogleHomeCommissioningKit.ts", import.meta.url)),
      "utf8",
    );
    assert.equal(runnerSource.includes("fetch("), false);
    assert.equal(runnerSource.includes("/execute"), false);
  });
});
