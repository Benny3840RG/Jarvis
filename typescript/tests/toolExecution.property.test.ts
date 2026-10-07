import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as fc from "fast-check";
import { z } from "zod";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  deriveToolExecutionIdempotencyKey,
  InMemoryToolExecutionReceiptStore,
  ToolExecutionService,
  type ToolExecutionReceipt,
} from "../src/actions/toolExecution.js";

const BASE_TIMESTAMP = "2026-10-07T00:00:00.000Z";

const baseAction: ToolAction = {
  actionId: "property-action",
  requestId: "property-request",
  projectId: "property-project",
  baseRevision: 1,
  state: "approved",
  tool: "clock",
  operation: "read",
  arguments: { zone: "UTC" },
  rationale: "Exercise governed tool execution properties.",
  requiredAuthority: "T1",
  destructive: false,
  idempotencyKey: "property-proposal",
  proposedBy: "user",
  approvedBy: "user",
  createdAt: BASE_TIMESTAMP,
  updatedAt: BASE_TIMESTAMP,
};

const actionIdArbitrary = fc
  .integer({ min: 0, max: 1_000_000 })
  .map((value) => `property-action-${value}`);
const zoneArbitrary = fc.constantFrom(
  "UTC",
  "Australia/Melbourne",
  "Pacific/Auckland",
  "Europe/London",
);

type AttemptKind = "live" | "dry-run" | "unauthorized" | "revoked" | "expired";

type Attempt = Readonly<{
  kind: AttemptKind;
  actionId: string;
  zone: string;
}>;

const attemptArbitrary: fc.Arbitrary<Attempt> = fc.record({
  kind: fc.constantFrom<AttemptKind>("live", "dry-run", "unauthorized", "revoked", "expired"),
  actionId: actionIdArbitrary,
  zone: zoneArbitrary,
});

const distinctZonePairArbitrary = fc
  .tuple(zoneArbitrary, zoneArbitrary)
  .filter(([first, second]) => first !== second);

const attemptSequenceArbitrary: fc.Arbitrary<Attempt[]> = fc
  .tuple(
    actionIdArbitrary,
    distinctZonePairArbitrary,
    fc.array(attemptArbitrary, { minLength: 1, maxLength: 22 }),
  )
  .map(([reusedActionId, [zone, changedZone], tail]): Attempt[] => [
    { kind: "live", actionId: reusedActionId, zone },
    { kind: "live", actionId: reusedActionId, zone },
    { kind: "live", actionId: reusedActionId, zone: changedZone },
    ...tail,
  ]);

function actionForAttempt(attempt: Attempt): ToolAction {
  const candidate: ToolAction = {
    ...baseAction,
    actionId: attempt.actionId,
    requestId: `request-${attempt.actionId}`,
    idempotencyKey: `proposal-${attempt.actionId}`,
    arguments: { zone: attempt.zone },
  };

  if (attempt.kind === "revoked") {
    return {
      ...candidate,
      state: "revoked",
      revokedBy: "user",
      revokedReason: "property-test",
    };
  }
  if (attempt.kind === "expired") {
    return { ...candidate, isApprovalExpired: true };
  }
  return candidate;
}

function createExecutor(counter: { count: number }): ToolExecutionService {
  return new ToolExecutionService(
    [
      {
        tool: "clock",
        operation: "read",
        schema: z.object({ zone: z.string() }),
        async execute(args) {
          counter.count += 1;
          return { zone: args.zone };
        },
      },
    ],
    new InMemoryToolExecutionReceiptStore(),
  );
}

describe("ToolExecutionService properties", () => {
  it("preserves execution invariants across generated attempt sequences", async () => {
    await fc.assert(
      fc.asyncProperty(attemptSequenceArbitrary, async (attempts) => {
        const effects = { count: 0 };
        const executor = createExecutor(effects);
        const liveReceipts = new Map<string, { zone: string; receipt: ToolExecutionReceipt }>();

        for (const attempt of attempts) {
          const action = actionForAttempt(attempt);
          const dryRun = attempt.kind === "dry-run";
          const executionKey = deriveToolExecutionIdempotencyKey(
            action.actionId,
            dryRun ? "dry-run" : "live",
          );
          const before = effects.count;
          const result = await executor.execute({
            action,
            authority: attempt.kind === "unauthorized" ? "T0" : "T1",
            idempotencyKey: executionKey,
            ...(dryRun ? { dryRun: true } : {}),
          });

          if (dryRun) {
            assert.equal(result.status, "dry-run");
            assert.equal(effects.count, before, "dry-run must not invoke the tool definition");
            continue;
          }

          const prior = liveReceipts.get(action.actionId);
          if (prior !== undefined) {
            if (prior.zone === attempt.zone) {
              assert.deepEqual(
                result,
                prior.receipt,
                "a completed logical execution must remain replayable byte-for-byte",
              );
              assert.equal(effects.count, before, "replay must not create a second effect");
            } else {
              assert.equal(result.status, "blocked");
              assert.equal(result.errorCode, "fingerprint-mismatch");
              assert.equal(
                effects.count,
                before,
                "changed content must not inherit an earlier receipt",
              );
            }
            continue;
          }

          if (attempt.kind === "unauthorized" || attempt.kind === "revoked") {
            assert.equal(result.status, "blocked");
            assert.equal(result.errorCode, "not-authorized");
            assert.equal(effects.count, before, "unauthorized attempts must not create effects");
            continue;
          }

          if (attempt.kind === "expired") {
            assert.equal(result.status, "blocked");
            assert.equal(result.errorCode, "approval-expired");
            assert.equal(effects.count, before, "expired approval must not create effects");
            continue;
          }

          assert.equal(result.status, "succeeded");
          assert.equal(effects.count, before + 1);
          liveReceipts.set(action.actionId, { zone: attempt.zone, receipt: result });
        }

        assert.equal(
          effects.count,
          liveReceipts.size,
          "each unique successful live action must create exactly one effect",
        );
      }),
      { numRuns: 60 },
    );
  });

  it("keeps changed dry-run payloads outside the authoritative replay scope", async () => {
    await fc.assert(
      fc.asyncProperty(
        actionIdArbitrary,
        distinctZonePairArbitrary,
        async (actionId, [firstZone, secondZone]) => {
          const effects = { count: 0 };
          const executor = createExecutor(effects);
          const executionKey = deriveToolExecutionIdempotencyKey(actionId, "dry-run");

          const first = await executor.execute({
            action: {
              ...baseAction,
              actionId,
              requestId: `request-${actionId}`,
              arguments: { zone: firstZone },
            },
            authority: "T1",
            idempotencyKey: executionKey,
            dryRun: true,
          });
          const second = await executor.execute({
            action: {
              ...baseAction,
              actionId,
              requestId: `request-${actionId}`,
              arguments: { zone: secondZone },
            },
            authority: "T1",
            idempotencyKey: executionKey,
            dryRun: true,
          });

          assert.equal(first.status, "dry-run");
          assert.equal(second.status, "dry-run");
          assert.equal(effects.count, 0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("limits concurrent single-use attempts to one external effect", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), zoneArbitrary, async (seed, zone) => {
        const effects = { count: 0 };
        const executor = createExecutor(effects);
        const singleUse: ToolAction = {
          ...baseAction,
          actionId: `single-use-${seed}`,
          requestId: `single-use-request-${seed}`,
          arguments: { zone },
          consumptionPolicy: "single-use",
        };

        const [first, second] = await Promise.all([
          executor.execute({
            action: singleUse,
            authority: "T1",
            idempotencyKey: `single-${seed}-a`,
          }),
          executor.execute({
            action: singleUse,
            authority: "T1",
            idempotencyKey: `single-${seed}-b`,
          }),
        ]);

        assert.equal(effects.count, 1, "single-use action must cross the effect boundary once");
        assert.deepEqual([first.status, second.status].sort(), ["blocked", "succeeded"]);
        const loser = first.status === "blocked" ? first : second;
        assert.equal(loser.errorCode, "approval-consumed");
      }),
      { numRuns: 40 },
    );
  });

  it("never lets dry-run consume a single-use action's live execution", async () => {
    await fc.assert(
      fc.asyncProperty(actionIdArbitrary, zoneArbitrary, async (actionId, zone) => {
        const effects = { count: 0 };
        const executor = createExecutor(effects);
        const singleUse: ToolAction = {
          ...baseAction,
          actionId,
          requestId: `request-${actionId}`,
          arguments: { zone },
          consumptionPolicy: "single-use",
        };

        const dryRun = await executor.execute({
          action: singleUse,
          authority: "T1",
          idempotencyKey: deriveToolExecutionIdempotencyKey(actionId, "dry-run"),
          dryRun: true,
        });
        const live = await executor.execute({
          action: singleUse,
          authority: "T1",
          idempotencyKey: deriveToolExecutionIdempotencyKey(actionId, "live"),
        });

        assert.equal(dryRun.status, "dry-run");
        assert.equal(live.status, "succeeded");
        assert.equal(effects.count, 1);
      }),
      { numRuns: 40 },
    );
  });

  it("never consumes a single-use claim when timeout validation rejects an attempt", async () => {
    const invalidTimeoutArbitrary = fc.oneof(
      fc.integer({ min: -100_000, max: 0 }),
      fc.integer({ min: 30_001, max: 100_000 }),
      fc.constant(1.5),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
    );

    await fc.assert(
      fc.asyncProperty(
        invalidTimeoutArbitrary,
        actionIdArbitrary,
        zoneArbitrary,
        async (timeoutMs, actionId, zone) => {
          const effects = { count: 0 };
          const executor = createExecutor(effects);
          const singleUse: ToolAction = {
            ...baseAction,
            actionId,
            requestId: `request-${actionId}`,
            arguments: { zone },
            consumptionPolicy: "single-use",
          };
          const invalidExecutionKey = deriveToolExecutionIdempotencyKey(actionId, "live");
          // Deliberately use a different claim ID for the retry. If timeout
          // validation ever moves below claim(), the first attempt will have
          // consumed invalidExecutionKey and this retry must then be blocked.
          const retryExecutionKey = `${invalidExecutionKey}:retry`;

          await assert.rejects(
            executor.execute({
              action: singleUse,
              authority: "T1",
              idempotencyKey: invalidExecutionKey,
              timeoutMs,
            }),
            /timeoutMs must be an integer between 1 and 30000/,
          );
          assert.equal(effects.count, 0);

          const retry = await executor.execute({
            action: singleUse,
            authority: "T1",
            idempotencyKey: retryExecutionKey,
          });
          assert.equal(retry.status, "succeeded");
          assert.equal(effects.count, 1);
        },
      ),
      { numRuns: 30 },
    );
  });
});
