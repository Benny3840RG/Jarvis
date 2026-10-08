import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveOutlookConnections } from "../src/auth/microsoftOutlookConnections.js";
import type { MicrosoftOutlookRuntime } from "../src/auth/microsoftOutlookRuntime.js";
import {
  executeOutlookQuoteCommissioning,
  type CommissioningRequest,
} from "../src/tools/runOutlookQuoteCommissioning.js";

const READY = {
  JARVIS_ENVIRONMENT: "development",
  CONVEX_DEPLOYMENT: "dev:outgoing-ram-798",
  CONVEX_URL: "https://outgoing-ram-798.convex.cloud",
  JARVIS_API_BASE_URL: "http://127.0.0.1:3100/",
  JARVIS_RECONCILIATION_ENABLED: "true",
  JARVIS_SERVICE_TOKEN: "service-token",
  JARVIS_APPROVAL_TOKEN: "approval-token",
  JARVIS_OUTLOOK_COMMISSIONING_PROJECT_KEY: "totality-dev",
  JARVIS_OUTLOOK_COMMISSIONING_CONFIRM: "non-customer",
  JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: "commissioning@example.invalid",
  JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: "commissioning@example.invalid",
};

const personal = {
  id: "personal",
  clientId: "aaaaaaaa-2222-3333-4444-555555555555",
  mailbox: "personal@outlook.com",
  refreshTokenFile: "/private/personal.token",
};
const business = {
  id: "business",
  clientId: "bbbbbbbb-2222-3333-4444-555555555555",
  mailbox: "business@example.com",
  tenantId: "11111111-2222-3333-4444-555555555555",
  refreshTokenFile: "/private/business.token",
};

function namedEnvironment() {
  return {
    ...READY,
    CONVEX_DEPLOYMENT: "dev:outgoing-ram-798 # systemd kept this comment",
    JARVIS_OUTLOOK_ENABLED: "true",
    JARVIS_OUTLOOK_CONNECTIONS_JSON: JSON.stringify([personal, business]),
    JARVIS_OUTLOOK_COMMISSIONING_CONNECTION: "personal",
  };
}

function inertOutlook(): MicrosoftOutlookRuntime {
  return {
    mailbox: "personal@outlook.com",
    quoteEmailProvider: {
      name: "microsoft-graph-mail-connections-v1",
      prepare() {
        return Promise.reject(new Error("must not prepare"));
      },
      sendPrepared() {
        return Promise.reject(new Error("must not send"));
      },
    },
    reconciliationAdapter: {
      provider: "microsoft-graph-mail-connections-v1",
      reconcile() {
        return Promise.reject(new Error("must not reconcile"));
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Call = { method: string; path: string; body?: unknown };

function quoteBody(status: string, fingerprint?: string): { status: number; body: unknown } {
  return {
    status: status === "draft" && fingerprint === undefined ? 201 : 200,
    body: {
      data: {
        aggregate: { quoteId: "quote-1", aggregateVersion: 1 },
        revision: {
          revision: 1,
          revisionVersion: 1,
          status,
          ...(fingerprint === undefined ? {} : { fingerprint }),
        },
      },
    },
  };
}

function stagingRequest(calls: Call[]): CommissioningRequest {
  return (input) => {
    calls.push({ method: input.method, path: input.path, body: input.body });
    if (input.method === "GET" && input.path === "/api/v1/clients") {
      return Promise.resolve({
        status: 200,
        body: {
          data: [
            {
              id: "phone-client",
              contacts: [{ value: "+1 (555) 010-0000" }, { value: "Ada Lovelace" }],
            },
          ],
        },
      });
    }
    if (input.method === "POST" && input.path === "/api/v1/clients") {
      return Promise.resolve({ status: 201, body: { data: { id: "client-1" } } });
    }
    if (input.method === "POST" && input.path === "/api/v1/quotes") {
      return Promise.resolve(quoteBody("draft"));
    }
    if (input.method === "PATCH" || input.path.endsWith("/review")) {
      return Promise.resolve({ ...quoteBody("draft"), status: 200 });
    }
    if (input.path.endsWith("/finalize")) {
      return Promise.resolve({ ...quoteBody("finalized", "fp-1"), status: 200 });
    }
    if (input.method === "POST" && input.path.endsWith("/tool-actions")) {
      return Promise.resolve({ status: 201, body: { baseRevision: 7 } });
    }
    if (input.method === "POST" && input.path.endsWith("/approve")) {
      return Promise.resolve({ status: 200, body: { state: "approved" } });
    }
    if (input.method === "POST" && input.path.endsWith("/execute")) {
      return Promise.resolve({ status: 200, body: { status: "blocked" } });
    }
    return Promise.reject(new Error(`unexpected ${input.method} ${input.path}`));
  };
}

describe("outlook quote commissioning run", () => {
  it("stages the named sender connection and keeps the existing approval", async () => {
    const connections = resolveOutlookConnections(namedEnvironment());
    const personalFingerprint = connections.find((connection) => connection.id === "personal");
    const businessFingerprint = connections.find((connection) => connection.id === "business");
    assert.ok(personalFingerprint);
    assert.ok(businessFingerprint);
    const calls: Call[] = [];
    let seenDeployment: string | undefined;
    await assert.rejects(
      () =>
        executeOutlookQuoteCommissioning(namedEnvironment(), {
          request: stagingRequest(calls),
          loadProjectRevision: () => Promise.resolve(7),
          createOutlookRuntime: (environment) => {
            seenDeployment = environment?.CONVEX_DEPLOYMENT;
            return inertOutlook();
          },
        }),
      /did not capture a Graph message identity/u,
    );
    assert.equal(seenDeployment, "dev:outgoing-ram-798");
    const staged = calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/tool-actions"),
    );
    assert.ok(staged);
    assert.ok(isRecord(staged.body));
    assert.ok(isRecord(staged.body.arguments));
    assert.equal(staged.body.arguments.senderConnection, personalFingerprint.senderConnection);
    assert.notEqual(staged.body.arguments.senderConnection, businessFingerprint.senderConnection);
    const approved = calls.find((call) => call.method === "POST" && call.path.endsWith("/approve"));
    assert.ok(approved);
    assert.ok(isRecord(approved.body));
    assert.equal(approved.body.approvalToken, "approval-token");
    assert.equal("senderConnection" in approved.body, false);
    assert.equal(
      calls.filter((call) => call.method === "POST" && call.path.endsWith("/execute")).length,
      1,
    );
  });

  it("omits senderConnection when named connections are not enabled", async () => {
    const calls: Call[] = [];
    await assert.rejects(
      () =>
        executeOutlookQuoteCommissioning(READY, {
          request: stagingRequest(calls),
          loadProjectRevision: () => Promise.resolve(7),
          createOutlookRuntime: () => inertOutlook(),
        }),
      /did not capture a Graph message identity/u,
    );
    const staged = calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/tool-actions"),
    );
    assert.ok(staged);
    assert.ok(isRecord(staged.body));
    assert.ok(isRecord(staged.body.arguments));
    assert.equal("senderConnection" in staged.body.arguments, false);
  });

  it("creates nothing when the totality project is missing", async () => {
    const calls: Call[] = [];
    const request: CommissioningRequest = (input) => {
      calls.push({ method: input.method, path: input.path });
      if (input.method === "GET" && input.path === "/api/v1/clients") {
        return Promise.resolve({ status: 200, body: { data: [] } });
      }
      return Promise.reject(new Error(`unexpected write ${input.method} ${input.path}`));
    };
    await assert.rejects(
      () =>
        executeOutlookQuoteCommissioning(namedEnvironment(), {
          request,
          loadProjectRevision: () => Promise.resolve(null),
          createOutlookRuntime: () => inertOutlook(),
        }),
      /totality project does not exist/u,
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["GET"],
    );
  });

  it("creates nothing when a contact could hide the recipient", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        executeOutlookQuoteCommissioning(READY, {
          request: (input) => {
            calls.push(input.method);
            if (input.method === "GET" && input.path === "/api/v1/clients") {
              return Promise.resolve({
                status: 200,
                body: { data: [{ contacts: [{ value: "not-quite@" }] }] },
              });
            }
            return Promise.reject(new Error(`unexpected write ${input.method}`));
          },
          loadProjectRevision: () => Promise.reject(new Error("project must not be read")),
          createOutlookRuntime: () => {
            throw new Error("runtime must not be created");
          },
        }),
      /could not be parsed into one mailbox/u,
    );
    assert.deepEqual(calls, ["GET"]);
  });

  it("creates nothing when a comment or lookalike hides the recipient", async () => {
    const recipient = "3840zip@gmail.com";
    const contacts = [
      "(3840zip@gmail.com)",
      "+1 (555) 010-0000 (3840zip@gmail.com)",
      "3840zip\u{FF20}gmail.com",
    ];
    for (const contact of contacts) {
      const calls: string[] = [];
      await assert.rejects(
        () =>
          executeOutlookQuoteCommissioning(
            {
              ...READY,
              JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: recipient,
              JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: recipient,
            },
            {
              request: (input) => {
                calls.push(input.method);
                if (input.method === "GET" && input.path === "/api/v1/clients") {
                  return Promise.resolve({
                    status: 200,
                    body: { data: [{ contacts: [{ value: contact }] }] },
                  });
                }
                return Promise.reject(new Error(`unexpected write ${input.method}`));
              },
              loadProjectRevision: () => Promise.reject(new Error("project must not be read")),
              createOutlookRuntime: () => {
                throw new Error("runtime must not be created");
              },
            },
          ),
        /matches a client contact/u,
      );
      assert.deepEqual(calls, ["GET"], contact);
    }
  });

  it("creates nothing when an encoded lookalike hides the recipient", async () => {
    const recipient = "3840zip@gmail.com";
    const cases = [
      {
        contact: "=?utf-8?q?3840zip=EF=BC=A0gmail.com?=",
        pattern: /matches a client contact/u,
      },
      {
        contact: "=?utf-8?q?3840zip=EF=B9=ABgmail.com?=",
        pattern: /matches a client contact/u,
      },
      {
        contact: "=?utf-8?b?Mzg0MHppcO+8oGdtYWlsLmNvbQ==?= <other@outlook.com>",
        pattern: /could not be parsed into one mailbox/u,
      },
      {
        contact: "<other@outlook.com> =?utf-8?b?Mzg0MHppcO+5q2dtYWlsLmNvbQ==?=",
        pattern: /could not be parsed into one mailbox/u,
      },
      { contact: "3840zip@gmai\u200Bl.com", pattern: /matches a client contact/u },
      {
        contact: "=?not-a-charset?q?3840zip=40gmail.com?=",
        pattern: /could not be parsed into one mailbox/u,
      },
      { contact: "=?utf-8?q?=ZZ?=", pattern: /could not be parsed into one mailbox/u },
    ];
    for (const { contact, pattern } of cases) {
      const calls: string[] = [];
      await assert.rejects(
        () =>
          executeOutlookQuoteCommissioning(
            {
              ...READY,
              JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: recipient,
              JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: recipient,
            },
            {
              request: (input) => {
                calls.push(input.method);
                if (input.method === "GET" && input.path === "/api/v1/clients") {
                  return Promise.resolve({
                    status: 200,
                    body: { data: [{ contacts: [{ value: contact }] }] },
                  });
                }
                return Promise.reject(new Error(`unexpected write ${input.method} ${input.path}`));
              },
              loadProjectRevision: () => Promise.reject(new Error("project must not be read")),
              createOutlookRuntime: () => {
                throw new Error("runtime must not be created");
              },
            },
          ),
        pattern,
      );
      assert.deepEqual(calls, ["GET"], contact);
    }
  });

  it("refuses a named connection id before any write when named mode is off", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        executeOutlookQuoteCommissioning(
          { ...READY, JARVIS_OUTLOOK_COMMISSIONING_CONNECTION: "personal" },
          {
            request: (input) => {
              calls.push(input.method);
              return Promise.resolve({ status: 200, body: { data: [] } });
            },
            createOutlookRuntime: () => {
              throw new Error("runtime must not be created");
            },
          },
        ),
      /only valid when named Outlook connections are enabled/u,
    );
    assert.deepEqual(calls, ["GET"]);
  });
});
