import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertOutlookCommissioningProof,
  assessOutlookQuoteCommissioningGuard,
  beginOutlookQuoteCommissioning,
  recipientCollidesWithContacts,
} from "../src/tools/outlookQuoteCommissioningGuard.js";

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
};

describe("outlook quote commissioning guard", () => {
  it("accepts a development deployment, loopback API, and confirmed non-customer mailbox", () => {
    const plan = assessOutlookQuoteCommissioningGuard(READY);
    assert.equal(plan.recipient, "commissioning@example.invalid");
    assert.equal(plan.projectKey, "totality-dev");
    assert.equal(plan.deployment, "dev:outgoing-ram-798");
  });

  it("accepts a loopback Convex URL", () => {
    const plan = assessOutlookQuoteCommissioningGuard({
      ...READY,
      CONVEX_URL: "http://127.0.0.1:3210",
    });
    assert.equal(plan.convexUrl, "http://127.0.0.1:3210/");
  });

  it("binds CONVEX_URL to the dev deployment slug before any client read", async () => {
    const plan = assessOutlookQuoteCommissioningGuard(READY);
    assert.equal(plan.convexUrl, "https://outgoing-ram-798.convex.cloud/");

    const refused = [
      "https://other.convex.cloud",
      "https://pleasant-octopus-123.convex.cloud",
      "https://evil.outgoing-ram-798.convex.cloud",
      "https://outgoing-ram-798.convex.cloud.evil.example",
      "https://user:pass@outgoing-ram-798.convex.cloud",
      "https://outgoing-ram-798.convex.cloud@evil.example",
      "https://outgoing-ram-798.convex.cloud:443",
      "https://outgoing-ram-798.convex.cloud:8443",
    ];
    for (const convexUrl of refused) {
      assert.throws(
        () => assessOutlookQuoteCommissioningGuard({ ...READY, CONVEX_URL: convexUrl }),
        /CONVEX_URL must be loopback or exactly the dev deployment host/,
        convexUrl,
      );
      let loaded = false;
      await assert.rejects(
        () =>
          beginOutlookQuoteCommissioning({
            environment: { ...READY, CONVEX_URL: convexUrl },
            loadClientContactValues: () => {
              loaded = true;
              return Promise.resolve([]);
            },
          }),
        /CONVEX_URL must be loopback or exactly the dev deployment host/,
      );
      assert.equal(loaded, false, convexUrl);
    }
  });

  it("refuses production and a prod deployment before any client read", async () => {
    assert.throws(
      () => assessOutlookQuoteCommissioningGuard({ ...READY, JARVIS_ENVIRONMENT: "production" }),
      /refused: JARVIS_ENVIRONMENT=production/,
    );
    assert.throws(
      () =>
        assessOutlookQuoteCommissioningGuard({
          ...READY,
          CONVEX_DEPLOYMENT: "prod:outgoing-ram-798",
        }),
      /CONVEX_DEPLOYMENT must identify a development deployment/,
    );
    let loaded = false;
    await assert.rejects(
      () =>
        beginOutlookQuoteCommissioning({
          environment: { ...READY, JARVIS_ENVIRONMENT: "production" },
          loadClientContactValues: () => {
            loaded = true;
            return Promise.resolve([]);
          },
        }),
      /JARVIS_ENVIRONMENT=production/,
    );
    assert.equal(loaded, false);
  });

  it("refuses a missing deployment, an anonymous deployment, and a non-dev host", () => {
    assert.throws(
      () => assessOutlookQuoteCommissioningGuard({ ...READY, CONVEX_DEPLOYMENT: undefined }),
      /CONVEX_DEPLOYMENT is required/,
    );
    assert.throws(
      () =>
        assessOutlookQuoteCommissioningGuard({
          ...READY,
          CONVEX_DEPLOYMENT: "anonymous:anonymous-agent",
        }),
      /development deployment/,
    );
    assert.throws(
      () => assessOutlookQuoteCommissioningGuard({ ...READY, CONVEX_DEPLOYMENT: "dev:" }),
      /development deployment/,
    );
    assert.throws(
      () =>
        assessOutlookQuoteCommissioningGuard({
          ...READY,
          CONVEX_URL: "https://jarvis.example",
        }),
      /CONVEX_URL must be loopback or exactly the dev deployment host/,
    );
    assert.throws(
      () =>
        assessOutlookQuoteCommissioningGuard({
          ...READY,
          JARVIS_API_BASE_URL: "https://jarvis.example",
        }),
      /JARVIS_API_BASE_URL must be a loopback URL/,
    );
  });

  it("refuses a missing confirmation, a bad mailbox, and a client-contact collision", async () => {
    assert.throws(
      () =>
        assessOutlookQuoteCommissioningGuard({
          ...READY,
          JARVIS_OUTLOOK_COMMISSIONING_CONFIRM: "yes",
        }),
      /must be non-customer/,
    );
    assert.throws(
      () =>
        assessOutlookQuoteCommissioningGuard({
          ...READY,
          JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: "not-an-email",
        }),
      /must be an email address/,
    );
    assert.equal(
      recipientCollidesWithContacts("Commissioning@example.invalid", [
        "other@example.invalid",
        "commissioning@example.invalid",
      ]),
      true,
    );
    await assert.rejects(
      () =>
        beginOutlookQuoteCommissioning({
          environment: READY,
          loadClientContactValues: () => Promise.resolve(["commissioning@example.invalid"]),
        }),
      /matches a client contact/,
    );
  });

  it("keeps the confirmed mailbox exact after normalisation", () => {
    const plan = assessOutlookQuoteCommissioningGuard({
      ...READY,
      JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: "Mailto:Ops <Commissioning@Example.invalid.>",
    });
    assert.equal(plan.recipient, "commissioning@example.invalid");
    const tagged = assessOutlookQuoteCommissioningGuard({
      ...READY,
      JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: "commissioning+tag@example.invalid",
    });
    assert.equal(tagged.recipient, "commissioning+tag@example.invalid");
  });

  it("refuses a normalised client contact before a quote is created", async () => {
    const cases = [
      {
        recipient: "customer@example.com",
        contacts: ["Name <customer@example.com>"],
      },
      {
        recipient: "customer@example.com",
        contacts: ["mailto:customer@example.com"],
      },
      {
        recipient: "customer+commission@example.com",
        contacts: ["customer@example.com"],
      },
      {
        recipient: "customer@example.com.",
        contacts: ["customer@example.com"],
      },
    ];
    for (const entry of cases) {
      assert.equal(recipientCollidesWithContacts(entry.recipient, entry.contacts), true);
      let loaded = false;
      await assert.rejects(
        () =>
          beginOutlookQuoteCommissioning({
            environment: {
              ...READY,
              JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: entry.recipient,
            },
            loadClientContactValues: () => {
              loaded = true;
              return Promise.resolve(entry.contacts);
            },
          }),
        /matches a client contact/,
      );
      assert.equal(loaded, true);
    }
  });

  it("records one terminal reconciliation and leaves #294 and #297 open", () => {
    const evidence = assertOutlookCommissioningProof({
      providerRequestId: "graph-message-1",
      repeatSendStatus: "failed",
      deliveryCount: 1,
      records: [
        {
          reconciliationId: "recon-1",
          providerRequestId: "graph-message-1",
          state: "resolved",
          terminalStatus: "succeeded",
        },
        {
          reconciliationId: "recon-other",
          providerRequestId: "graph-message-2",
          state: "resolved",
          terminalStatus: "succeeded",
        },
      ],
    });
    assert.deepEqual(evidence.issues, { "294": "OPEN", "297": "OPEN" });
    assert.equal(evidence.satisfied, false);
    assert.equal(evidence.reconciliationId, "recon-1");
    assert.equal(evidence.matchingReconciliationCount, 1);
    assert.equal(evidence.repeatSendPrevented, true);
  });

  it("rejects a missing message id, a second delivery, a repeat that was not prevented, and duplicate reconciliations", () => {
    const base = {
      providerRequestId: "graph-message-1",
      repeatSendStatus: "failed",
      deliveryCount: 1,
      records: [
        {
          reconciliationId: "recon-1",
          providerRequestId: "graph-message-1",
          state: "resolved",
          terminalStatus: "succeeded",
        },
      ],
    };
    assert.throws(
      () => assertOutlookCommissioningProof({ ...base, providerRequestId: " " }),
      /immutable Graph message id/,
    );
    assert.throws(
      () => assertOutlookCommissioningProof({ ...base, deliveryCount: 2 }),
      /expected exactly one/,
    );
    assert.throws(
      () => assertOutlookCommissioningProof({ ...base, repeatSendStatus: "indeterminate" }),
      /prevented repeat send/,
    );
    assert.throws(
      () =>
        assertOutlookCommissioningProof({
          ...base,
          records: [...base.records, { ...base.records[0], reconciliationId: "recon-dup" }],
        }),
      /expected exactly one/,
    );
    assert.throws(
      () =>
        assertOutlookCommissioningProof({
          ...base,
          records: [{ ...base.records[0], state: "observing", terminalStatus: undefined }],
        }),
      /exactly one terminal reconciliation/,
    );
  });
});
