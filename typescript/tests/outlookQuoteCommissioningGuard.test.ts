import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertOutlookCommissioningProof,
  assessOutlookQuoteCommissioningGuard,
  beginOutlookQuoteCommissioning,
  normaliseCommissioningEnvironment,
  recipientCollidesWithContacts,
  stripUnquotedTrailingComment,
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
  JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: "commissioning@example.invalid",
};

async function rejectsBeforeClientRead(
  environment: Record<string, string | undefined>,
  pattern: RegExp,
): Promise<void> {
  assert.throws(() => assessOutlookQuoteCommissioningGuard(environment), pattern);
  let loaded = false;
  await assert.rejects(
    () =>
      beginOutlookQuoteCommissioning({
        environment,
        loadClientContactValues: () => {
          loaded = true;
          return Promise.resolve(["customer@example.com"]);
        },
      }),
    pattern,
  );
  assert.equal(loaded, false);
}

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

  it("refuses a plaintext Convex cloud URL before any client read", async () => {
    const convexUrl = "http://outgoing-ram-798.convex.cloud";
    assert.throws(
      () => assessOutlookQuoteCommissioningGuard({ ...READY, CONVEX_URL: convexUrl }),
      /CONVEX_URL for a Convex cloud host must be https/,
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
      /CONVEX_URL for a Convex cloud host must be https/,
    );
    assert.equal(loaded, false);
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

  it("keeps a plain plus-tag exact and does not repair a display name", () => {
    assert.throws(
      () =>
        assessOutlookQuoteCommissioningGuard({
          ...READY,
          JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: "Mailto:Ops <Commissioning@Example.invalid.>",
        }),
      /must be an email address/,
    );
    const tagged = "commissioning+tag@example.invalid";
    const plan = assessOutlookQuoteCommissioningGuard({
      ...READY,
      JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: "Commissioning+Tag@Example.invalid",
      JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: tagged,
    });
    assert.equal(plan.recipient, tagged);
  });

  it("sends only to an allowlisted plain mailbox and refuses the rest before any client read", async () => {
    const plan = await beginOutlookQuoteCommissioning({
      environment: READY,
      loadClientContactValues: () => Promise.resolve(["other@example.invalid"]),
    });
    assert.equal(plan.recipient, "commissioning@example.invalid");

    await rejectsBeforeClientRead(
      { ...READY, JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: undefined },
      /RECIPIENT_ALLOWLIST is required/,
    );
    await rejectsBeforeClientRead(
      { ...READY, JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: " , " },
      /at least one plain email address/,
    );
    await rejectsBeforeClientRead(
      {
        ...READY,
        JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: "other@example.invalid",
      },
      /not on the commissioning allowlist/,
    );
    await rejectsBeforeClientRead(
      {
        ...READY,
        JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: "commissioning@example.invalid.",
      },
      /must list plain email addresses/,
    );

    const recipientBypasses = [
      "customer@example.com.",
      "customer@example.com..",
      "customer@example.com...",
      '"customer"@example.com',
      "customer(comment)@example.com",
      "=?utf-8?q?customer?=@example.com",
      "Name <customer@example.com..>",
    ];
    for (const recipient of recipientBypasses) {
      await rejectsBeforeClientRead(
        {
          ...READY,
          JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: recipient,
          JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: "customer@example.com",
        },
        /must be an email address/,
      );
    }
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
        recipient: "customer@example.com",
        contacts: ["customer@example.com."],
      },
      {
        recipient: "customer@example.com",
        contacts: ["customer@example.com.."],
      },
      {
        recipient: "customer@example.com",
        contacts: ["customer@example.com..."],
      },
      {
        recipient: "customer@example.com",
        contacts: ["Name <customer@example.com..>"],
      },
      {
        recipient: "customer@example.com",
        contacts: ['"customer"@example.com'],
      },
      {
        recipient: "customer@example.com",
        contacts: ["customer(comment)@example.com"],
      },
      {
        recipient: "customer@example.com",
        contacts: ["(comment)customer@example.com"],
      },
      {
        recipient: "customer@example.com",
        contacts: ["customer@(comment)example.com"],
      },
      {
        recipient: "customer@example.com",
        contacts: ["=?utf-8?q?customer?=@example.com"],
      },
    ];
    for (const entry of cases) {
      assert.equal(
        recipientCollidesWithContacts(entry.recipient, entry.contacts),
        true,
        entry.contacts[0],
      );
      let loaded = false;
      await assert.rejects(
        () =>
          beginOutlookQuoteCommissioning({
            environment: {
              ...READY,
              JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: entry.recipient,
              JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: entry.recipient,
            },
            loadClientContactValues: () => {
              loaded = true;
              return Promise.resolve(entry.contacts);
            },
          }),
        /matches a client contact/,
      );
      assert.equal(loaded, true, entry.contacts[0]);
    }

    const skipped = await beginOutlookQuoteCommissioning({
      environment: READY,
      loadClientContactValues: () => Promise.resolve(["not-a-mailbox"]),
    });
    assert.equal(skipped.recipient, READY.JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT);

    let contained = false;
    await assert.rejects(
      () =>
        beginOutlookQuoteCommissioning({
          environment: {
            ...READY,
            JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: "customer@example.com",
            JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: "customer@example.com",
          },
          loadClientContactValues: () => {
            contained = true;
            return Promise.resolve(["customer@example.com.extra"]);
          },
        }),
      /matches a client contact/,
    );
    assert.equal(contained, true);
  });

  it("refuses a second mailbox hidden beside an angle address before anything is staged", async () => {
    const contacts = [
      "Name <other@evil.com> customer(note)@example.com",
      'Name <other@evil.com> "customer"@example.com',
      "Name <other@evil.com> =?utf-8?q?customer=40example.com?=",
      "customer(note)@example.com <other@evil.com>",
      "=?utf-8?q?customer=40example.com?= <other@evil.com>",
    ];
    for (const contact of contacts) {
      let staged = 0;
      let sent = 0;
      await assert.rejects(async () => {
        const plan = await beginOutlookQuoteCommissioning({
          environment: {
            ...READY,
            JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: "customer@example.com",
            JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: "customer@example.com",
          },
          loadClientContactValues: () => Promise.resolve([contact]),
        });
        staged += 1;
        sent += 1;
        void plan;
      }, /could not be parsed into one mailbox/);
      assert.equal(staged, 0, contact);
      assert.equal(sent, 0, contact);
    }
  });

  it("ignores phone numbers and names, and still refuses an ambiguous address", async () => {
    const accepted = await beginOutlookQuoteCommissioning({
      environment: READY,
      loadClientContactValues: () =>
        Promise.resolve([
          "+1 (555) 010-0000",
          "07123 456789",
          "Ada Lovelace",
          "=?utf-8?q?workshop_phone?=",
          "other@example.com",
          "(other@example.com)",
        ]),
    });
    assert.equal(accepted.recipient, "commissioning@example.invalid");

    const ambiguous = [
      "not-quite@",
      "Name <not-an-email>",
      "customer@example.com extra",
      "+1 555 =?utf-8?q?customer=40example.com?=",
    ];
    for (const contact of ambiguous) {
      let staged = 0;
      let sent = 0;
      await assert.rejects(async () => {
        const plan = await beginOutlookQuoteCommissioning({
          environment: READY,
          loadClientContactValues: () => Promise.resolve([contact]),
        });
        staged += 1;
        sent += 1;
        void plan;
      }, /could not be parsed into one mailbox/);
      assert.equal(staged, 0, contact);
      assert.equal(sent, 0, contact);
    }

    await assert.rejects(
      () =>
        beginOutlookQuoteCommissioning({
          environment: READY,
          loadClientContactValues: () =>
            Promise.resolve(["07123 456789", "commissioning@example.invalid"]),
        }),
      /matches a client contact/,
    );
  });

  it("refuses a comment-wrapped or lookalike mailbox before anything is staged", async () => {
    const recipient = "3840zip@gmail.com";
    const hidden = [
      "(3840zip@gmail.com)",
      "Ada Lovelace (3840zip@gmail.com)",
      "+1 (555) 010-0000 (3840zip@gmail.com)",
      "+61 400 000 000 (3840zip@gmail.com)",
      "=?utf-8?q?=283840zip=40gmail=2Ecom=29?=",
      "3840zip\u{FF20}gmail.com",
      "3840zip\u{FE6B}gmail.com",
      "3840zip\u{FF20}gmail\u{FF0E}com",
    ];
    for (const contact of hidden) {
      let staged = 0;
      let sent = 0;
      await assert.rejects(async () => {
        const plan = await beginOutlookQuoteCommissioning({
          environment: {
            ...READY,
            JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: recipient,
            JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: recipient,
          },
          loadClientContactValues: () => Promise.resolve([contact]),
        });
        staged += 1;
        sent += 1;
        void plan;
      }, /matches a client contact/);
      assert.equal(staged, 0, contact);
      assert.equal(sent, 0, contact);
    }

    const unparseable = ["(not-quite@)", "not-quite\u{FF20}", "(3840zip@gmail.com extra)"];
    for (const contact of unparseable) {
      let staged = 0;
      let sent = 0;
      await assert.rejects(async () => {
        const plan = await beginOutlookQuoteCommissioning({
          environment: {
            ...READY,
            JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: recipient,
            JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: recipient,
          },
          loadClientContactValues: () => Promise.resolve([contact]),
        });
        staged += 1;
        sent += 1;
        void plan;
      }, /could not be parsed into one mailbox/);
      assert.equal(staged, 0, contact);
      assert.equal(sent, 0, contact);
    }
  });

  it("refuses a charset-decoded lookalike before anything is staged", async () => {
    const recipient = "3840zip@gmail.com";
    const environment = {
      ...READY,
      JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT: recipient,
      JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST: recipient,
    };
    const collisions = [
      "=?utf-8?q?3840zip=EF=BC=A0gmail.com?=",
      "=?utf-8?q?3840zip=EF=B9=ABgmail.com?=",
      "=?iso-8859-1?q?3840zip=40gmail.com?=",
      "3840zip@gmai\u200Bl.com",
      "3840\u200Czip@gmail.com",
      "3840zip@gmail\u2060.com",
      "3840zip@gm\u00ADail.com",
    ];
    for (const contact of collisions) {
      let staged = 0;
      let sent = 0;
      await assert.rejects(async () => {
        const plan = await beginOutlookQuoteCommissioning({
          environment,
          loadClientContactValues: () => Promise.resolve([contact]),
        });
        staged += 1;
        sent += 1;
        void plan;
      }, /matches a client contact/);
      assert.equal(staged, 0, contact);
      assert.equal(sent, 0, contact);
    }

    const unreadable = [
      "=?not-a-charset?q?3840zip=40gmail.com?=",
      "=?utf-8?q?=ZZ?=",
      "=?utf-8?q?3840zip=40gmail.com",
      "=?utf-8?b?Mzg0MHppcO+8oGdtYWlsLmNvbQ==?= <other@outlook.com>",
      "<other@outlook.com> =?utf-8?b?Mzg0MHppcO+5q2dtYWlsLmNvbQ==?=",
    ];
    for (const contact of unreadable) {
      let staged = 0;
      let sent = 0;
      await assert.rejects(async () => {
        const plan = await beginOutlookQuoteCommissioning({
          environment,
          loadClientContactValues: () => Promise.resolve([contact]),
        });
        staged += 1;
        sent += 1;
        void plan;
      }, /could not be parsed into one mailbox/);
      assert.equal(staged, 0, contact);
      assert.equal(sent, 0, contact);
    }

    const latin1NotUtf8 = await beginOutlookQuoteCommissioning({
      environment,
      loadClientContactValues: () =>
        Promise.resolve(["=?iso-8859-1?q?3840zip=EF=BC=A0gmail.com?="]),
    });
    assert.equal(latin1NotUtf8.recipient, recipient);
  });

  it("strips one unquoted CONVEX_DEPLOYMENT comment and still refuses production", () => {
    assert.equal(
      stripUnquotedTrailingComment("dev:outgoing-ram-798 # systemd kept this comment"),
      "dev:outgoing-ram-798",
    );
    assert.equal(
      stripUnquotedTrailingComment('"dev:outgoing-ram-798 # comment"'),
      '"dev:outgoing-ram-798 # comment"',
    );
    const plan = assessOutlookQuoteCommissioningGuard({
      ...READY,
      CONVEX_DEPLOYMENT: "dev:outgoing-ram-798 # systemd kept this comment",
    });
    assert.equal(plan.deployment, "dev:outgoing-ram-798");
    const normalised = normaliseCommissioningEnvironment({
      ...READY,
      JARVIS_SERVICE_TOKEN: "service # not a comment",
      CONVEX_DEPLOYMENT: "dev:outgoing-ram-798 # systemd kept this comment",
    });
    assert.equal(normalised.CONVEX_DEPLOYMENT, "dev:outgoing-ram-798");
    assert.equal(normalised.JARVIS_SERVICE_TOKEN, "service # not a comment");
    assert.throws(
      () =>
        assessOutlookQuoteCommissioningGuard({
          ...READY,
          CONVEX_DEPLOYMENT: "prod:outgoing-ram-798 # comment",
        }),
      /CONVEX_DEPLOYMENT must identify a development deployment/,
    );
    assert.throws(
      () =>
        assessOutlookQuoteCommissioningGuard({
          ...READY,
          CONVEX_DEPLOYMENT: "dev:outgoing-ram-798#glued",
        }),
      /CONVEX_DEPLOYMENT must identify a development deployment/,
    );
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
