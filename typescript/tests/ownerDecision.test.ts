import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertLedgerIntact,
  confirmationPhrase,
  ownerDecisionDigest,
  OwnerDecisionManifestError,
  parseOwnerDecisionManifest,
  type OwnerDecisionManifest,
} from "../src/ownerGate/ownerDecision.js";
import {
  InMemoryOwnerDecisionLedger,
  JsonLinesOwnerDecisionLedger,
  loadOwnerDecisionManifest,
  OwnerDecisionRefusal,
  OwnerDecisionService,
} from "../src/ownerGate/ownerDecisionService.js";

const SHA = "a".repeat(40);
const NOW = Date.parse("2026-11-12T00:00:00.000Z");

function rawEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Decision ${id}`,
    issues: [1],
    proposedAction: "Do the thing.",
    consequence: "The thing is done.",
    scope: "One thing.",
    environment: "development",
    risk: "standard",
    subject: { kind: "issue", ref: "#1", sha: SHA },
    dependsOn: [],
    evidence: [{ label: "Issue", url: "https://github.com/example/repo/issues/1" }],
    missingPrerequisites: [],
    rollback: "Undo the thing.",
    expiresAt: "2026-12-01T00:00:00.000Z",
    ...overrides,
  };
}

function manifestOf(...entries: Record<string, unknown>[]): OwnerDecisionManifest {
  return parseOwnerDecisionManifest({
    version: 1,
    repository: "example/repo",
    decisions: entries,
    excluded: [],
  });
}

function serviceOf(
  manifest: OwnerDecisionManifest,
  options: Partial<ConstructorParameters<typeof OwnerDecisionService>[0]> = {},
) {
  let now = NOW;
  const ledger = options.ledger ?? new InMemoryOwnerDecisionLedger();
  const service = new OwnerDecisionService({
    manifest,
    ledger,
    approvalConfigured: () => true,
    clock: () => now,
    ...options,
  });
  return {
    service,
    ledger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function digestOf(manifest: OwnerDecisionManifest, id: string): string {
  return ownerDecisionDigest(manifest.decisions.find((entry) => entry.id === id)!);
}

function refusal(code: string) {
  return (error: unknown) => error instanceof OwnerDecisionRefusal && error.code === code;
}

let keyCounter = 0;
const key = () => `test-key-${(keyCounter += 1)}`;

test("the shipped manifest is valid and never offers a not-ready card as ready", async () => {
  const manifest = loadOwnerDecisionManifest();
  const { service } = serviceOf(manifest);
  const queue = await service.inspect();
  assert.equal(queue.cards.length, manifest.decisions.length);
  for (const issue of [294, 297, 567, 779, 697, 306, 307, 324]) {
    assert.ok(
      queue.cards.some((card) => card.entry.issues.includes(issue)),
      `issue #${issue} is mapped to a card`,
    );
  }
  for (const card of queue.cards) {
    if (card.status === "READY") assert.deepEqual(card.blockedBy, []);
    if (card.status === "NOT_READY") assert.notDeepEqual(card.blockedBy, []);
    if (card.entry.environment === "production") assert.equal(card.entry.risk, "high");
  }
  assert.deepEqual(
    manifest.excluded.map((item) => item.issue),
    [561, 734, 742, 801],
  );
});

test("a malformed manifest is rejected whole", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["short SHA", { subject: { kind: "issue", ref: "#1", sha: "abc" } }],
    ["production at standard risk", { environment: "production" }],
    ["high risk without a kind", { risk: "high" }],
    [
      "evidence outside the repository",
      { evidence: [{ label: "x", url: "https://evil.example/" }] },
    ],
    ["unknown dependency", { dependsOn: ["missing"] }],
    ["self dependency", { dependsOn: ["a"] }],
    ["unexpected field", { approvedAlready: true }],
    ["non-canonical expiry", { expiresAt: "2026-12-01" }],
  ];
  for (const [name, overrides] of cases) {
    assert.throws(() => manifestOf(rawEntry("a", overrides)), OwnerDecisionManifestError, name);
  }
  assert.throws(() => manifestOf(rawEntry("a"), rawEntry("a")), /Duplicate/);
});

test("one click approves a ready card and writes one chained audit record", async () => {
  const manifest = manifestOf(rawEntry("a"));
  const { service, ledger } = serviceOf(manifest);
  const result = await service.decide({
    decisionId: "a",
    expectedDigest: digestOf(manifest, "a"),
    choice: "approve",
    idempotencyKey: key(),
    actor: "owner",
  });
  assert.equal(result.card.status, "APPROVED");
  assert.equal(result.replayed, false);
  const records = await ledger.read();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.subjectSha, SHA);
  assert.equal(records[0]!.environment, "development");
  assertLedgerIntact(records);
});

test("a double click with the same key records once; a second key is refused", async () => {
  const manifest = manifestOf(rawEntry("a"));
  const { service, ledger } = serviceOf(manifest);
  const request = {
    decisionId: "a",
    expectedDigest: digestOf(manifest, "a"),
    choice: "approve" as const,
    idempotencyKey: key(),
    actor: "owner",
  };
  const [first, second] = await Promise.all([service.decide(request), service.decide(request)]);
  assert.equal(first.recordId, second.recordId);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
  assert.equal((await ledger.read()).length, 1);
  await assert.rejects(
    () => service.decide({ ...request, idempotencyKey: key() }),
    refusal("already-decided"),
  );
  await assert.rejects(
    () => service.decide({ ...request, choice: "reject" }),
    refusal("idempotency-conflict"),
  );
  assert.equal((await ledger.read()).length, 1);
});

test("concurrent approvals of one card produce exactly one record", async () => {
  const manifest = manifestOf(rawEntry("a"));
  const { service, ledger } = serviceOf(manifest);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      service.decide({
        decisionId: "a",
        expectedDigest: digestOf(manifest, "a"),
        choice: "approve",
        idempotencyKey: key(),
        actor: "owner",
      }),
    ),
  );
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal((await ledger.read()).length, 1);
});

test("a stale digest, a moved subject and an expired request are refused", async () => {
  const manifest = manifestOf(rawEntry("a"));
  const request = {
    decisionId: "a",
    expectedDigest: digestOf(manifest, "a"),
    choice: "approve" as const,
    actor: "owner",
  };
  const stale = serviceOf(manifest);
  await assert.rejects(
    () =>
      stale.service.decide({ ...request, expectedDigest: "0".repeat(64), idempotencyKey: key() }),
    refusal("stale"),
  );

  const moved = serviceOf(manifest, { subjectProbe: async () => ({ sha: "b".repeat(40) }) });
  await assert.rejects(
    () => moved.service.decide({ ...request, idempotencyKey: key() }),
    refusal("subject-changed"),
  );
  const unknown = serviceOf(manifest, { subjectProbe: async () => null });
  await assert.rejects(
    () => unknown.service.decide({ ...request, idempotencyKey: key() }),
    refusal("unavailable"),
  );
  const same = serviceOf(manifest, { subjectProbe: async () => ({ sha: SHA }) });
  assert.equal(
    (await same.service.decide({ ...request, idempotencyKey: key() })).card.status,
    "APPROVED",
  );

  const expired = serviceOf(manifest);
  expired.advance(30 * 24 * 60 * 60 * 1000);
  assert.equal((await expired.service.inspect()).cards[0]!.status, "EXPIRED");
  await assert.rejects(
    () => expired.service.decide({ ...request, idempotencyKey: key() }),
    refusal("expired"),
  );
  for (const world of [stale, moved, unknown, expired]) {
    assert.equal((await world.ledger.read()).length, 0);
  }
});

test("an approval lapses when the request expires before execution", async () => {
  const manifest = manifestOf(rawEntry("a"));
  const { service, advance } = serviceOf(manifest);
  const expectedDigest = digestOf(manifest, "a");
  await service.decide({
    decisionId: "a",
    expectedDigest,
    choice: "approve",
    idempotencyKey: key(),
    actor: "owner",
  });
  advance(30 * 24 * 60 * 60 * 1000);
  assert.equal((await service.inspect()).cards[0]!.status, "EXPIRED");
  await assert.rejects(
    () =>
      service.reportExecution({
        decisionId: "a",
        expectedDigest,
        status: "executed",
        idempotencyKey: key(),
        actor: "operator",
      }),
    refusal("not-approved"),
  );
});

test("missing evidence and unmet dependencies block approval but not rejection", async () => {
  const manifest = manifestOf(
    rawEntry("a", { missingPrerequisites: ["No evidence run exists."] }),
    rawEntry("b", { dependsOn: ["a"] }),
  );
  const { service } = serviceOf(manifest);
  const cards = (await service.inspect()).cards;
  assert.deepEqual(
    cards.map((card) => card.status),
    ["NOT_READY", "NOT_READY"],
  );
  assert.match(cards[1]!.blockedBy[0]!, /Depends on "Decision a", which is NOT_READY/);
  for (const id of ["a", "b"]) {
    await assert.rejects(
      () =>
        service.decide({
          decisionId: id,
          expectedDigest: digestOf(manifest, id),
          choice: "approve",
          idempotencyKey: key(),
          actor: "owner",
        }),
      refusal("not-ready"),
    );
  }
  const rejected = await service.decide({
    decisionId: "a",
    expectedDigest: digestOf(manifest, "a"),
    choice: "reject",
    idempotencyKey: key(),
    note: "Not wanted.",
    actor: "owner",
  });
  assert.equal(rejected.card.status, "REJECTED");
  assert.equal(rejected.card.decision?.note, "Not wanted.");
});

test("a dependency becomes ready only after its prerequisite is approved", async () => {
  const manifest = manifestOf(rawEntry("a"), rawEntry("b", { dependsOn: ["a"] }));
  const { service } = serviceOf(manifest);
  await service.decide({
    decisionId: "a",
    expectedDigest: digestOf(manifest, "a"),
    choice: "approve",
    idempotencyKey: key(),
    actor: "owner",
  });
  assert.equal((await service.inspect()).cards[1]!.status, "READY");
});

test("a high-risk card needs its own typed confirmation", async () => {
  const manifest = manifestOf(
    rawEntry("deploy", {
      environment: "production",
      risk: "high",
      highRiskKind: "production-deployment",
    }),
  );
  const { service, ledger } = serviceOf(manifest);
  const request = {
    decisionId: "deploy",
    expectedDigest: digestOf(manifest, "deploy"),
    choice: "approve" as const,
    actor: "owner",
  };
  for (const confirmation of [undefined, "APPROVE", "approve deploy", "APPROVE other"]) {
    await assert.rejects(
      () =>
        service.decide({
          ...request,
          idempotencyKey: key(),
          ...(confirmation === undefined ? {} : { confirmation }),
        }),
      refusal("confirmation-required"),
    );
  }
  assert.equal((await ledger.read()).length, 0);
  const phrase = confirmationPhrase(manifest.decisions[0]!);
  assert.equal(phrase, "APPROVE deploy");
  const approved = await service.decide({
    ...request,
    idempotencyKey: key(),
    confirmation: phrase,
  });
  assert.equal(approved.card.status, "APPROVED");
});

test("revoked approval authority makes the queue read-only", async () => {
  const manifest = manifestOf(rawEntry("a"));
  let configured = true;
  const { service, ledger } = serviceOf(manifest, { approvalConfigured: () => configured });
  configured = false;
  const queue = await service.inspect();
  assert.equal(queue.decisionsAvailable, false);
  assert.match(queue.unavailableReason ?? "", /read-only/);
  assert.equal(queue.cards[0]!.status, "READY");
  await assert.rejects(
    () =>
      service.decide({
        decisionId: "a",
        expectedDigest: digestOf(manifest, "a"),
        choice: "approve",
        idempotencyKey: key(),
        actor: "owner",
      }),
    refusal("unavailable"),
  );
  assert.equal((await ledger.read()).length, 0);
});

test("approval is separate from execution, and an indeterminate result stays visible", async () => {
  const manifest = manifestOf(rawEntry("a"));
  const { service } = serviceOf(manifest);
  const expectedDigest = digestOf(manifest, "a");
  const report = (status: "executed" | "failed" | "indeterminate") =>
    service.reportExecution({
      decisionId: "a",
      expectedDigest,
      status,
      idempotencyKey: key(),
      reference: "run 42",
      actor: "operator",
    });
  await assert.rejects(() => report("executed"), refusal("not-approved"));
  const approved = await service.decide({
    decisionId: "a",
    expectedDigest,
    choice: "approve",
    idempotencyKey: key(),
    actor: "owner",
  });
  assert.equal(approved.card.execution, undefined);

  const unknown = await report("indeterminate");
  assert.equal(unknown.card.status, "APPROVED");
  assert.equal(unknown.card.execution?.status, "indeterminate");
  const done = await report("executed");
  assert.equal(done.card.status, "EXECUTED");
  assert.equal(done.card.execution?.reference, "run 42");
  await assert.rejects(() => report("failed"), refusal("already-executed"));
  await assert.rejects(
    () =>
      service.decide({
        decisionId: "a",
        expectedDigest,
        choice: "reject",
        idempotencyKey: key(),
        actor: "owner",
      }),
    refusal("already-decided"),
  );
});

test("a failed execution is final for that approval, and an approval can be withdrawn", async () => {
  const manifest = manifestOf(rawEntry("a"));
  const { service } = serviceOf(manifest);
  const expectedDigest = digestOf(manifest, "a");
  const decide = (choice: "approve" | "reject") =>
    service.decide({ decisionId: "a", expectedDigest, choice, idempotencyKey: key(), actor: "o" });
  const report = (status: "executed" | "failed") =>
    service.reportExecution({
      decisionId: "a",
      expectedDigest,
      status,
      idempotencyKey: key(),
      actor: "operator",
    });
  await decide("approve");
  const failed = await report("failed");
  assert.equal(failed.card.status, "APPROVED");
  assert.equal(failed.card.execution?.status, "failed");
  await assert.rejects(() => report("executed"), refusal("already-executed"));
  assert.equal((await decide("reject")).card.status, "REJECTED");
  await assert.rejects(() => report("executed"), refusal("not-approved"));
});

test("a changed card drops the old decision and a tampered ledger fails closed", async () => {
  const before = manifestOf(rawEntry("a"));
  const ledger = new InMemoryOwnerDecisionLedger();
  await serviceOf(before, { ledger }).service.decide({
    decisionId: "a",
    expectedDigest: digestOf(before, "a"),
    choice: "approve",
    idempotencyKey: key(),
    actor: "owner",
  });
  const after = manifestOf(
    rawEntry("a", { subject: { kind: "issue", ref: "#1", sha: "c".repeat(40) } }),
  );
  const card = (await serviceOf(after, { ledger }).service.inspect()).cards[0]!;
  assert.equal(card.status, "READY");
  assert.equal(card.supersededDecisions, 1);

  const [record] = await ledger.read();
  const tampered = new InMemoryOwnerDecisionLedger();
  await tampered.append({ ...record!, decision: "reject" });
  const broken = serviceOf(before, { ledger: tampered }).service;
  const queue = await broken.inspect();
  assert.equal(queue.decisionsAvailable, false);
  assert.equal(queue.cards[0]!.decision, undefined);
  await assert.rejects(
    () =>
      broken.decide({
        decisionId: "a",
        expectedDigest: digestOf(before, "a"),
        choice: "approve",
        idempotencyKey: key(),
        actor: "owner",
      }),
    refusal("unavailable"),
  );
});

test("the file ledger appends owner-only lines and survives a restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owner-decisions-"));
  try {
    const file = path.join(root, "nested", "decisions.jsonl");
    const manifest = manifestOf(rawEntry("a"), rawEntry("b"));
    for (const id of ["a", "b"]) {
      await serviceOf(manifest, { ledger: new JsonLinesOwnerDecisionLedger(file) }).service.decide({
        decisionId: id,
        expectedDigest: digestOf(manifest, id),
        choice: id === "a" ? "approve" : "request-changes",
        idempotencyKey: key(),
        actor: "owner",
      });
    }
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.readFile(file, "utf8")).trimEnd().split("\n").length, 2);
    const reopened = serviceOf(manifest, { ledger: new JsonLinesOwnerDecisionLedger(file) });
    assert.deepEqual(
      (await reopened.service.inspect()).cards.map((card) => card.status),
      ["APPROVED", "CHANGES_REQUESTED"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
