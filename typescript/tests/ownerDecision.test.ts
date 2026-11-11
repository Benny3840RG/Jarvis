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

const REVISION = "2026-11-01T00:00:00Z";
const SUBJECT = { kind: "issue", number: 1, revision: REVISION } as const;
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
    subjects: [SUBJECT],
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
    // By default every subject is confirmed unchanged.
    subjectProbe: async (subject) => subject.revision,
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
    ["short SHA", { subjects: [{ kind: "pull-request", number: 1, revision: "abc" }] }],
    [
      "issue pinned to a commit",
      { subjects: [{ kind: "issue", number: 1, revision: "a".repeat(40) }] },
    ],
    ["no subject", { subjects: [] }],
    [
      "branch with a number",
      { subjects: [{ kind: "branch", number: 1, revision: "a".repeat(40) }] },
    ],
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
  assert.deepEqual(records[0]!.subjects, [SUBJECT]);
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

  const moved = serviceOf(manifest, { subjectProbe: async () => "2026-11-02T00:00:00Z" });
  await assert.rejects(
    () => moved.service.decide({ ...request, idempotencyKey: key() }),
    refusal("subject-changed"),
  );
  const unknown = serviceOf(manifest, { subjectProbe: async () => null });
  await assert.rejects(
    () => unknown.service.decide({ ...request, idempotencyKey: key() }),
    refusal("unavailable"),
  );
  // No live check at all is the same as an unknown answer: nothing is approved.
  const unprobedLedger = new InMemoryOwnerDecisionLedger();
  const unprobed = new OwnerDecisionService({
    manifest,
    ledger: unprobedLedger,
    approvalConfigured: () => true,
  });
  assert.equal((await unprobed.inspect()).subjectVerification, "none");
  await assert.rejects(
    () => unprobed.decide({ ...request, idempotencyKey: key() }),
    refusal("unavailable"),
  );
  assert.equal((await unprobedLedger.read()).length, 0);
  assert.equal(
    (await unprobed.decide({ ...request, choice: "reject", idempotencyKey: key() })).card.status,
    "REJECTED",
  );
  const same = serviceOf(manifest);
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

test("every subject of a card is checked, and one changed subject refuses the approval", async () => {
  const manifest = manifestOf(
    rawEntry("a", {
      subjects: [SUBJECT, { kind: "pull-request", number: 7, revision: "a".repeat(40) }],
    }),
  );
  const asked: string[] = [];
  const { service, ledger } = serviceOf(manifest, {
    subjectProbe: async (subject) => {
      asked.push(subject.kind);
      return subject.kind === "pull-request" ? "b".repeat(40) : subject.revision;
    },
  });
  await assert.rejects(
    () =>
      service.decide({
        decisionId: "a",
        expectedDigest: digestOf(manifest, "a"),
        choice: "approve",
        idempotencyKey: key(),
        actor: "owner",
      }),
    (error: unknown) =>
      error instanceof OwnerDecisionRefusal &&
      error.code === "subject-changed" &&
      /pull request #7/.test(error.message),
  );
  assert.deepEqual(asked, ["issue", "pull-request"]);
  assert.equal((await ledger.read()).length, 0);
});

test("revoked approval authority makes the queue read-only for every write", async () => {
  const manifest = manifestOf(rawEntry("a"), rawEntry("b"));
  let configured = true;
  const { service, ledger } = serviceOf(manifest, { approvalConfigured: () => configured });
  await service.decide({
    decisionId: "b",
    expectedDigest: digestOf(manifest, "b"),
    choice: "approve",
    idempotencyKey: key(),
    actor: "owner",
  });
  configured = false;
  await assert.rejects(
    () =>
      service.reportExecution({
        decisionId: "b",
        expectedDigest: digestOf(manifest, "b"),
        status: "executed",
        idempotencyKey: key(),
        actor: "operator",
      }),
    refusal("unavailable"),
  );
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
  assert.equal((await ledger.read()).length, 1);
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
  // An unresolved effect cannot be buried by withdrawing the approval.
  for (const choice of ["reject", "request-changes"] as const) {
    await assert.rejects(
      () =>
        service.decide({
          decisionId: "a",
          expectedDigest,
          choice,
          idempotencyKey: key(),
          actor: "owner",
        }),
      refusal("execution-unresolved"),
    );
  }
  assert.equal((await service.inspect()).cards[0]!.execution?.status, "indeterminate");
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
  const withdrawn = await decide("reject");
  assert.equal(withdrawn.card.status, "REJECTED");
  assert.equal(withdrawn.card.execution?.status, "failed", "the failed effect stays visible");
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
    rawEntry("a", { subjects: [{ kind: "issue", number: 1, revision: "2026-11-05T00:00:00Z" }] }),
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

async function fileWorld() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owner-decisions-"));
  const file = path.join(root, "nested", "decisions.jsonl");
  const checkpoint = `${file}.checkpoint.json`;
  const manifest = manifestOf(rawEntry("a"), rawEntry("b"));
  const open = () =>
    serviceOf(manifest, { ledger: new JsonLinesOwnerDecisionLedger(file) }).service;
  const decide = (id: string, service = open()) =>
    service.decide({
      decisionId: id,
      expectedDigest: digestOf(manifest, id),
      choice: "approve",
      idempotencyKey: key(),
      actor: "owner",
    });
  return { root, file, checkpoint, manifest, open, decide };
}

test("a runtime with no ledger records nothing until one is started on purpose", async () => {
  const world = await fileWorld();
  try {
    const service = world.open();
    const queue = await service.inspect();
    assert.equal(queue.ledgerState, "not-started");
    assert.equal(queue.decisionsAvailable, false);
    assert.match(queue.unavailableReason ?? "", /restored from a backup/);
    await assert.rejects(() => world.decide("a", service), refusal("unavailable"));
    await assert.rejects(fs.stat(world.file), /ENOENT/);

    await service.startLedger();
    assert.equal((await service.inspect()).ledgerState, "ready");
    await assert.rejects(() => service.startLedger(), refusal("ledger-exists"));
    assert.equal((await world.decide("a", service)).card.status, "APPROVED");
  } finally {
    await fs.rm(world.root, { recursive: true, force: true });
  }
});

test("the file ledger keeps owner-only files and survives a restart", async () => {
  const world = await fileWorld();
  try {
    await world.open().startLedger();
    await world.decide("a");
    await world.decide("b");
    for (const file of [world.file, world.checkpoint]) {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
    assert.equal((await fs.readFile(world.file, "utf8")).trimEnd().split("\n").length, 2);
    assert.deepEqual(
      (await world.open().inspect()).cards.map((card) => card.status),
      ["APPROVED", "APPROVED"],
    );
  } finally {
    await fs.rm(world.root, { recursive: true, force: true });
  }
});

test("a shortened, emptied or deleted ledger fails closed instead of forgetting a decision", async () => {
  const world = await fileWorld();
  try {
    await world.open().startLedger();
    await world.decide("a");
    await world.decide("b");
    const full = await fs.readFile(world.file, "utf8");
    const savedCheckpoint = await fs.readFile(world.checkpoint, "utf8");
    const [first] = full.trimEnd().split("\n");
    const variants: [string, () => Promise<void>][] = [
      ["last record removed", () => fs.writeFile(world.file, `${first}\n`)],
      ["all records removed", () => fs.writeFile(world.file, "")],
      ["ledger deleted", () => fs.rm(world.file)],
      ["checkpoint deleted", () => fs.rm(world.checkpoint)],
      [
        "checkpoint rewound",
        () => fs.writeFile(world.checkpoint, JSON.stringify({ count: 0, hash: "0".repeat(64) })),
      ],
      ["checkpoint corrupt", () => fs.writeFile(world.checkpoint, "{")],
    ];
    for (const [name, damage] of variants) {
      await damage();
      const service = world.open();
      const queue = await service.inspect();
      assert.equal(queue.ledgerState, "damaged", name);
      assert.equal(queue.decisionsAvailable, false, name);
      assert.ok(
        queue.cards.every((card) => card.decision === undefined),
        name,
      );
      await assert.rejects(() => world.decide("b", service), refusal("unavailable"), name);
      await assert.rejects(() => service.startLedger(), refusal("ledger-exists"), name);
      await fs.writeFile(world.file, full, { mode: 0o600 });
      await fs.writeFile(world.checkpoint, savedCheckpoint, { mode: 0o600 });
    }
    assert.equal((await world.open().inspect()).ledgerState, "ready");
  } finally {
    await fs.rm(world.root, { recursive: true, force: true });
  }
});

test("an incomplete last record is refused and never appended after", async () => {
  const world = await fileWorld();
  try {
    await world.open().startLedger();
    await world.decide("a");
    const full = await fs.readFile(world.file, "utf8");
    for (const torn of [full.slice(0, -1), `${full}{"sequence":2`]) {
      await fs.writeFile(world.file, torn);
      const service = world.open();
      assert.equal((await service.inspect()).ledgerState, "damaged");
      await assert.rejects(() => world.decide("b", service), refusal("unavailable"));
      assert.equal(await fs.readFile(world.file, "utf8"), torn);
    }
  } finally {
    await fs.rm(world.root, { recursive: true, force: true });
  }
});

test("a record written just before a crash, ahead of the checkpoint, is kept", async () => {
  const world = await fileWorld();
  try {
    await world.open().startLedger();
    await world.decide("a");
    const before = await fs.readFile(world.checkpoint, "utf8");
    await world.decide("b");
    await fs.writeFile(world.checkpoint, before);
    const queue = await world.open().inspect();
    assert.equal(queue.ledgerState, "ready");
    assert.deepEqual(
      queue.cards.map((card) => card.status),
      ["APPROVED", "APPROVED"],
    );
  } finally {
    await fs.rm(world.root, { recursive: true, force: true });
  }
});

test("a ledger file with loose permissions or behind a symlink is refused", async () => {
  const world = await fileWorld();
  try {
    await world.open().startLedger();
    await world.decide("a");
    const before = await fs.readFile(world.file, "utf8");

    await fs.chmod(world.file, 0o644);
    const loose = world.open();
    assert.equal((await loose.inspect()).ledgerState, "damaged");
    await assert.rejects(() => world.decide("b", loose), refusal("unavailable"));
    assert.equal(await fs.readFile(world.file, "utf8"), before);
    await fs.chmod(world.file, 0o600);

    const elsewhere = path.join(world.root, "elsewhere.jsonl");
    await fs.rename(world.file, elsewhere);
    await fs.symlink(elsewhere, world.file);
    const linked = world.open();
    assert.equal((await linked.inspect()).ledgerState, "damaged");
    await assert.rejects(() => world.decide("b", linked), refusal("unavailable"));
    assert.equal(await fs.readFile(elsewhere, "utf8"), before);
  } finally {
    await fs.rm(world.root, { recursive: true, force: true });
  }
});
