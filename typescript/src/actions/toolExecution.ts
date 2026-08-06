import { createHash } from "node:crypto";

import type { z } from "zod";

import type {
  ExternalExecutionScope,
  ExternalReconciliationStore,
  ProviderAttemptReference,
} from "../reconciliation/externalReconciliation.js";
import {
  externalExecutionScopeKey,
  providerReferenceFromRecord,
} from "../reconciliation/externalReconciliation.js";
import { bindSafety } from "../safety/safetyBinder.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";
import { canonicalJson } from "./canonicalJson.js";
import type { ToolAction } from "./toolActions.js";

export type ToolExecutionStatus = "dry-run" | "succeeded" | "failed" | "indeterminate" | "blocked";

export type ToolExecutionErrorCode =
  | "not-authorized"
  | "not-allowlisted"
  | "invalid-arguments"
  | "indeterminate"
  | "failed"
  | "fingerprint-mismatch"
  | "provider-failed"
  | "provider-reference-missing"
  | "retry-blocked-pending-reconciliation"
  | "reconciliation-escalated"
  | "reconciliation-unavailable"
  | "approval-expired"
  | "approval-consumed"
  | "safety-blocked";

export type ToolExecutionReceipt = {
  receiptId: string;
  actionId: string;
  requestId: string;
  projectId: string;
  idempotencyKey: string;
  actionFingerprint: string;
  effectFingerprint?: string;
  tool: string;
  operation: string;
  actor: ToolAction["proposedBy"];
  approvalId?: string;
  policyVersion: string;
  correlationId: string;
  source: string;
  provider?: string;
  providerRequestId?: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  status: ToolExecutionStatus;
  outputDigest?: string;
  errorCode?: ToolExecutionErrorCode;
  providerErrorCode?: string;
  startedAt: string;
  completedAt: string;
};

export type ToolExecutionContext = {
  action: ToolAction;
  idempotencyKey: string;
  actionFingerprint: string;
  effectFingerprint: string;
  correlationId: string;
  source: string;
  approvalId?: string;
  policyVersion: string;
  registerProviderAttempt(reference: ProviderAttemptReference): Promise<void>;
};

export type ToolExecutionDefinition = {
  tool: string;
  operation: string;
  schema: z.ZodType<Record<string, unknown>>;
  externalProvider?: string;
  execute: (
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
};

export interface ToolExecutionReceiptStore {
  get(key: string): Promise<ToolExecutionReceipt | null>;
  save(key: string, receipt: ToolExecutionReceipt): Promise<void>;
}

export class InMemoryToolExecutionReceiptStore implements ToolExecutionReceiptStore {
  private readonly receipts = new Map<string, ToolExecutionReceipt>();

  async get(key: string): Promise<ToolExecutionReceipt | null> {
    return this.receipts.get(key) ?? null;
  }

  async save(key: string, receipt: ToolExecutionReceipt): Promise<void> {
    this.receipts.set(key, receipt);
  }
}

export type SingleUseExecutionClaimResult = {
  claimed: boolean;
  claimId: string;
  /**
   * Present when `claimed` is false. `"already-claimed"` means a winner
   * already holds the claim (the existing replay-safe path). `"not-approved"`
   * and `"expired"` mean the store's own authoritative, same-transaction
   * check found the action no longer approved or its approval expired —
   * decided fresh at claim time, never from the caller's earlier snapshot.
   */
  blockReason?: "already-claimed" | "not-approved" | "expired";
};

/**
 * Authoritative, atomic consumption gate for single-use governed actions.
 * `claim()` must return `{claimed: true}` for exactly one caller across any
 * number of concurrent attempts against the same action — every other
 * caller (including a caller retrying its own already-lost attempt) must
 * receive `{claimed: false, claimId: <winner's claimId>}` without ever
 * having invoked, or being told to invoke, the external effect. The claim
 * is never released once set.
 */
export interface SingleUseConsumptionClaimStore {
  claim(action: ToolAction, claimId: string): Promise<SingleUseExecutionClaimResult>;
}

export class InMemorySingleUseConsumptionClaimStore implements SingleUseConsumptionClaimStore {
  private readonly claims = new Map<string, string>();

  // No `await` occurs between the read and the write below, so this method
  // runs to completion in one synchronous turn of the event loop before
  // yielding — the same guarantee a real backend must provide via OCC or an
  // equivalent transactional check-and-set.
  async claim(action: ToolAction, claimId: string): Promise<SingleUseExecutionClaimResult> {
    const existing = this.claims.get(action.actionId);
    if (existing !== undefined) return { claimed: false, claimId: existing };
    this.claims.set(action.actionId, claimId);
    return { claimed: true, claimId };
  }
}

export type ExecutionEligibilityResult = {
  eligible: boolean;
  /** Present when `eligible` is false; same meaning as the identically-named `SingleUseExecutionClaimResult` reasons. */
  blockReason?: "not-approved" | "expired";
};

/**
 * The reusable-action counterpart to `SingleUseConsumptionClaimStore`: the
 * same authoritative, execute-time re-check of state/expiry, but with no
 * claim/consumption semantics, since a reusable action may execute more than
 * once. `verify()` must be called and must return `{eligible: true}`
 * immediately before a reusable action's external effect may be attempted —
 * skipping it leaves the same revoke/expire-during-flight race that the
 * single-use claim closes, just for actions that were never given a claim to
 * make atomic in the first place.
 */
export interface ExecutionEligibilityStore {
  verify(action: ToolAction): Promise<ExecutionEligibilityResult>;
}

/**
 * Matches `InMemorySingleUseConsumptionClaimStore`'s own scope: this default
 * provides no independent freshness guarantee (it has no authoritative store
 * to re-read from other than the snapshot it's handed), the same limitation
 * already accepted for the in-memory single-use claim store. The real
 * guarantee comes from `ConvexExecutionEligibilityStore`'s backing mutation;
 * tests exercising the blocked branches use a hand-written test double, the
 * same pattern already used to test `SingleUseConsumptionClaimStore`'s
 * blocked branches.
 */
export class InMemoryExecutionEligibilityStore implements ExecutionEligibilityStore {
  async verify(): Promise<ExecutionEligibilityResult> {
    return { eligible: true };
  }
}

const AUTHORITY_LEVEL: Record<ToolAuthority, number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};
const MAX_TIMEOUT_MS = 30_000;
const ACTION_FINGERPRINT_VERSION = "jarvis-action-fingerprint:v1";
const EFFECT_FINGERPRINT_VERSION = "jarvis-effect-fingerprint:v1";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function deriveToolExecutionIdempotencyKey(
  actionId: string,
  mode: "live" | "dry-run",
): string {
  const cleanActionId = actionId.trim();
  if (!cleanActionId) {
    throw new Error("Tool action ID is required for execution idempotency.");
  }
  return `tool-action-execution:v1:${mode}:${digest({ actionId: cleanActionId, mode })}`;
}

function isEffectFingerprintConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("another effect fingerprint") ||
    error.message.includes("effect fingerprint collision")
  );
}
export function fingerprintToolAction(action: ToolAction): string {
  const hash = digest({
    actionId: action.actionId,
    projectId: action.projectId,
    baseRevision: action.baseRevision,
    tool: action.tool,
    operation: action.operation,
    arguments: action.arguments,
    requiredAuthority: action.requiredAuthority,
    destructive: action.destructive,
  });
  return `${ACTION_FINGERPRINT_VERSION}:${hash}`;
}

export function fingerprintToolEffect(action: ToolAction): string {
  const hash = digest({
    projectId: action.projectId,
    tool: action.tool,
    operation: action.operation,
    arguments: action.arguments,
    destructive: action.destructive,
  });
  return `${EFFECT_FINGERPRINT_VERSION}:${hash}`;
}

function internalExecutionKey(action: ToolAction, idempotencyKey: string): string {
  return `${action.projectId}:${action.actionId}:${idempotencyKey}`;
}

function externalScope(
  action: ToolAction,
  idempotencyKey: string,
  effectFingerprint: string,
): ExternalExecutionScope {
  return {
    projectId: action.projectId,
    tool: action.tool,
    operation: action.operation,
    idempotencyKey,
    effectFingerprint,
  };
}

function externalExecutionKey(scope: ExternalExecutionScope): string {
  return `external:${externalExecutionScopeKey(scope)}`;
}

function reconciliationId(scope: ExternalExecutionScope): string {
  return `reconciliation-${digest(scope).slice(0, 32)}`;
}

/**
 * Computes the same reconciliation ID `ToolExecutionService` derives
 * internally for a given external execution scope. External tool
 * definitions that keep their own domain-specific projection (e.g. the quote
 * delivery ledger) can call this from inside `execute()` — using the
 * `action`/`idempotencyKey`/`effectFingerprint` already exposed on
 * `ToolExecutionContext` — to record a reconciliation ID that is guaranteed
 * to match the one `ExternalReconciliationStore` will actually use, without
 * duplicating the hashing scheme.
 */
export function computeExternalReconciliationId(
  action: ToolAction,
  idempotencyKey: string,
  effectFingerprint: string,
): string {
  return reconciliationId(externalScope(action, idempotencyKey, effectFingerprint));
}

function receiptId(
  action: ToolAction,
  idempotencyKey: string,
  status: ToolExecutionStatus,
): string {
  return digest({
    projectId: action.projectId,
    actionId: action.actionId,
    idempotencyKey,
    status,
  }).slice(0, 32);
}

type ExecutionMetadata = {
  approvalId?: string;
  policyVersion?: string;
  correlationId?: string;
  source?: string;
};

type ReceiptMetadata = ExecutionMetadata & {
  actionFingerprint?: string;
  effectFingerprint?: string;
  provider?: string;
  providerRequestId?: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  providerErrorCode?: string;
};

function receipt(
  action: ToolAction,
  idempotencyKey: string,
  status: ToolExecutionStatus,
  errorCode: ToolExecutionReceipt["errorCode"],
  startedAt: string,
  metadata: ReceiptMetadata,
): ToolExecutionReceipt {
  return {
    receiptId: receiptId(action, idempotencyKey, status),
    actionId: action.actionId,
    requestId: action.requestId,
    projectId: action.projectId,
    idempotencyKey,
    actionFingerprint: metadata.actionFingerprint ?? fingerprintToolAction(action),
    ...(metadata.effectFingerprint === undefined
      ? {}
      : { effectFingerprint: metadata.effectFingerprint }),
    tool: action.tool,
    operation: action.operation,
    actor: action.proposedBy,
    ...(metadata.approvalId === undefined ? {} : { approvalId: metadata.approvalId }),
    policyVersion: metadata.policyVersion ?? "totality-policy:v1",
    correlationId: metadata.correlationId ?? action.requestId,
    source: metadata.source ?? "tool-execution-service",
    ...(metadata.provider === undefined ? {} : { provider: metadata.provider }),
    ...(metadata.providerRequestId === undefined
      ? {}
      : { providerRequestId: metadata.providerRequestId }),
    ...(metadata.providerCorrelationId === undefined
      ? {}
      : { providerCorrelationId: metadata.providerCorrelationId }),
    ...(metadata.reconciliationId === undefined
      ? {}
      : { reconciliationId: metadata.reconciliationId }),
    status,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(metadata.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: metadata.providerErrorCode }),
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

type ExecuteInput = {
  action: ToolAction;
  authority: ToolAuthority;
  idempotencyKey: string;
  timeoutMs?: number;
  dryRun?: boolean;
  approvalId?: string;
  policyVersion?: string;
  correlationId?: string;
  source?: string;
};

export class ToolExecutionService {
  private readonly definitions = new Map<string, ToolExecutionDefinition>();
  private readonly inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<ToolExecutionReceipt> }
  >();

  constructor(
    definitions: readonly ToolExecutionDefinition[],
    private readonly receipts: ToolExecutionReceiptStore = new InMemoryToolExecutionReceiptStore(),
    private readonly reconciliations?: ExternalReconciliationStore,
    private readonly claims: SingleUseConsumptionClaimStore = new InMemorySingleUseConsumptionClaimStore(),
    private readonly eligibility: ExecutionEligibilityStore = new InMemoryExecutionEligibilityStore(),
  ) {
    for (const definition of definitions) {
      const key = `${definition.tool}:${definition.operation}`;
      if (this.definitions.has(key)) throw new Error(`Duplicate tool definition: ${key}`);
      if (definition.externalProvider !== undefined && reconciliations === undefined) {
        throw new Error(`External tool definition ${key} requires an ExternalReconciliationStore.`);
      }
      this.definitions.set(key, definition);
    }
  }

  /** Whether a `tool:operation` definition is registered — evidence for integration-commissioning checks. */
  isRegistered(tool: string, operation: string): boolean {
    return this.definitions.has(`${tool}:${operation}`);
  }

  async execute(input: ExecuteInput): Promise<ToolExecutionReceipt> {
    const definition = this.definitions.get(`${input.action.tool}:${input.action.operation}`);
    const effectFingerprint = fingerprintToolEffect(input.action);
    const external = definition?.externalProvider !== undefined;
    const scope = external
      ? externalScope(input.action, input.idempotencyKey, effectFingerprint)
      : undefined;
    const key = scope
      ? externalExecutionKey(scope)
      : internalExecutionKey(input.action, input.idempotencyKey);
    const expectedFingerprint = external ? effectFingerprint : fingerprintToolAction(input.action);

    if (scope && definition?.externalProvider) {
      const replay = await this.replayExternal(input, definition.externalProvider, scope, key);
      if (replay) return replay;
    }

    const existing = await this.receipts.get(key);
    if (existing) {
      const existingFingerprint = external
        ? existing.effectFingerprint
        : existing.actionFingerprint;
      if (existingFingerprint !== expectedFingerprint) {
        return this.persistDecision(
          key,
          receipt(
            input.action,
            input.idempotencyKey,
            "blocked",
            "fingerprint-mismatch",
            new Date().toISOString(),
            {
              ...input,
              ...(external ? { effectFingerprint } : {}),
            },
          ),
        );
      }
      return existing;
    }

    const active = this.inFlight.get(key);
    if (active) {
      if (active.fingerprint !== expectedFingerprint) {
        return this.persistDecision(
          key,
          receipt(
            input.action,
            input.idempotencyKey,
            "blocked",
            "fingerprint-mismatch",
            new Date().toISOString(),
            {
              ...input,
              ...(external ? { effectFingerprint } : {}),
            },
          ),
        );
      }
      return active.promise;
    }

    const execution = this.executeOnce(input, definition, key, effectFingerprint, scope);
    this.inFlight.set(key, {
      fingerprint: expectedFingerprint,
      promise: execution,
    });
    try {
      return await execution;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async replayExternal(
    input: ExecuteInput,
    provider: string,
    scope: ExternalExecutionScope,
    key: string,
  ): Promise<ToolExecutionReceipt | null> {
    if (!this.reconciliations) throw new Error("External reconciliation store is unavailable.");
    let envelope;
    try {
      envelope = await this.reconciliations.getByScope(scope);
    } catch (error: unknown) {
      const errorCode = isEffectFingerprintConflict(error)
        ? "fingerprint-mismatch"
        : "reconciliation-unavailable";
      return this.persistDecision(
        key,
        receipt(
          input.action,
          input.idempotencyKey,
          "blocked",
          errorCode,
          new Date().toISOString(),
          { ...input, effectFingerprint: scope.effectFingerprint, provider },
        ),
      );
    }
    if (!envelope) return null;
    if (envelope.receipt) return envelope.receipt;

    const startedAt = new Date().toISOString();
    const providerReference = providerReferenceFromRecord(envelope.reconciliation);
    const unresolved = receipt(
      input.action,
      input.idempotencyKey,
      "indeterminate",
      envelope.reconciliation.state === "escalated"
        ? "reconciliation-escalated"
        : "retry-blocked-pending-reconciliation",
      startedAt,
      {
        ...input,
        actionFingerprint: envelope.reconciliation.actionFingerprint,
        effectFingerprint: envelope.reconciliation.effectFingerprint,
        provider,
        ...(providerReference === null
          ? {}
          : {
              providerRequestId: providerReference.providerRequestId,
              providerCorrelationId: providerReference.providerCorrelationId,
            }),
        reconciliationId: envelope.reconciliation.reconciliationId,
      },
    );
    const bound = await this.reconciliations.markIndeterminate({
      ...scope,
      reconciliationId: envelope.reconciliation.reconciliationId,
      executionKey: envelope.reconciliation.executionKey,
      actionId: envelope.reconciliation.actionId,
      requestId: envelope.reconciliation.requestId,
      actionFingerprint: envelope.reconciliation.actionFingerprint,
      expectedProvider: provider,
      receiptKey: key,
      receipt: unresolved,
      ...(providerReference === null
        ? {
            missingReferenceReason: "reconciliation-record-has-no-provider-request",
          }
        : {}),
    });
    if (!bound.receipt)
      throw new Error("External replay did not produce an authoritative receipt.");
    return bound.receipt;
  }

  private async persistDecision(
    key: string,
    decision: ToolExecutionReceipt,
  ): Promise<ToolExecutionReceipt> {
    const decisionKey = `${key}:decision:${decision.receiptId}:${decision.completedAt}`;
    await this.receipts.save(decisionKey, decision);
    return decision;
  }

  private async executeOnce(
    input: ExecuteInput,
    definition: ToolExecutionDefinition | undefined,
    key: string,
    effectFingerprint: string,
    scope: ExternalExecutionScope | undefined,
  ): Promise<ToolExecutionReceipt> {
    const startedAt = new Date().toISOString();

    if (
      input.action.state !== "approved" ||
      AUTHORITY_LEVEL[input.authority] < AUTHORITY_LEVEL[input.action.requiredAuthority]
    ) {
      return this.persistDecision(
        key,
        receipt(input.action, input.idempotencyKey, "blocked", "not-authorized", startedAt, input),
      );
    }
    // isApprovalExpired is computed server-side by the caller's fetch of the
    // action (never client-supplied), so this is a truthful, server-derived
    // check — not a caller-controlled clock. Legacy/pre-consent-lifecycle
    // rows never set this field, so it stays undefined (falsy) and
    // unenforced for them, matching the additive migration's own rule that
    // rows without an explicit classification are legacy/unenforced.
    if (input.action.isApprovalExpired) {
      return this.persistDecision(
        key,
        receipt(
          input.action,
          input.idempotencyKey,
          "blocked",
          "approval-expired",
          startedAt,
          input,
        ),
      );
    }
    const externalProvider = definition?.externalProvider;
    const safetyBinding = bindSafety({
      phase: "tool-execute",
      riskLevel: "moderate",
      domainBound: true,
      memorySafe: true,
      reliabilityHealthy: !externalProvider || this.reconciliations !== undefined,
      proposalSafe: true,
      toolAllowlisted: definition !== undefined,
      requiredAuthority: input.action.requiredAuthority,
      grantedAuthority: input.authority,
      actionState: "execute",
      requiresApproval: true,
      approvalPresent: input.action.state === "approved" && !input.action.isApprovalExpired,
      destructive: input.action.destructive,
      externalEffect: externalProvider !== undefined,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId ?? input.action.requestId,
      payload: input.action.arguments,
      stateValid: input.action.state === "approved" && !input.action.isApprovalExpired,
      outcome: "pending",
      recoveryAvailable: externalProvider === undefined || this.reconciliations !== undefined,
    });
    if (safetyBinding.status === "blocked") {
      const safetyReasons = safetyBinding.categories.flatMap((category) => category.reasons);
      const onlyAllowlistFailure =
        safetyReasons.length > 0 &&
        safetyReasons.every(
          (reason) => reason === "The tool action is not present in the reviewed allowlist.",
        );
      return this.persistDecision(
        key,
        receipt(
          input.action,
          input.idempotencyKey,
          "blocked",
          onlyAllowlistFailure ? "not-allowlisted" : "safety-blocked",
          startedAt,
          input,
        ),
      );
    }

    if (!definition) {
      return this.persistDecision(
        key,
        receipt(input.action, input.idempotencyKey, "blocked", "not-allowlisted", startedAt, input),
      );
    }

    const parsed = definition.schema.safeParse(input.action.arguments);
    if (!parsed.success) {
      return this.persistDecision(
        key,
        receipt(
          input.action,
          input.idempotencyKey,
          "blocked",
          "invalid-arguments",
          startedAt,
          input,
        ),
      );
    }
    if (input.dryRun) {
      return this.persistDecision(
        key,
        receipt(input.action, input.idempotencyKey, "dry-run", undefined, startedAt, input),
      );
    }

    // Deterministic and must run before the claim below: an invalid
    // `timeoutMs` throws, and a throw here happens *before* any claim has
    // been taken, so nothing is spent. Validating this *after* the claim
    // would durably consume a single-use action's one-and-only attempt for
    // an error that has nothing to do with authorization or consumption —
    // the claim is never released, so a legitimate retry would then be
    // blocked as `"approval-consumed"` for an action that never actually
    // reached the provider. (Independent review finding: this check
    // previously ran after the claim.)
    const timeoutMs = input.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }

    // Authoritative, execute-time re-check — placed as close as possible to
    // the actual external-effect call below, after every deterministic
    // pre-check (authority, expiry, allowlist, argument validation, dry-run,
    // timeout) has already passed.
    //
    // The earlier `input.action.state`/`isApprovalExpired` checks above run
    // against the caller's own, separately-fetched, potentially stale
    // snapshot — revocation or TTL expiry can land on the authoritative
    // document in the gap between that fetch and this call. Both branches
    // below re-verify against a fresh, same-transaction read instead of that
    // stale snapshot; a `blockReason` of `"not-approved"` or `"expired"`
    // means the store's own fresh read caught exactly that race, and must
    // map to the same receipt codes the earlier checks would have produced
    // had they seen current state.
    //
    // Single-use actions additionally need claim *uniqueness*: two
    // different-key concurrent callers racing to this point both call
    // claim(); the store's own atomicity (Convex OCC for the real
    // deployment, a synchronous check-then-set for the in-memory default)
    // guarantees exactly one caller receives `claimed: true`, and the claim
    // is never released, so a `blockReason` of `"approval-consumed"` proves
    // this is a replay of a claim someone else already holds — never
    // confusable with the "not-approved"/"expired" cases above.
    //
    // Reusable actions have nothing to claim (they may legitimately execute
    // more than once), but skipping this re-check for them would leave the
    // exact same revoke/expire-during-flight race open — only for actions
    // that were never given a claim to make atomic. `verify()` closes it
    // without any consumption semantics. (Finding from a full-repo audit:
    // this re-check previously ran only for single-use actions.)
    if (input.action.consumptionPolicy === "single-use") {
      const claim = await this.claims.claim(input.action, input.idempotencyKey);
      if (!claim.claimed) {
        const errorCode =
          claim.blockReason === "not-approved"
            ? "not-authorized"
            : claim.blockReason === "expired"
              ? "approval-expired"
              : "approval-consumed";
        return this.persistDecision(
          key,
          receipt(input.action, input.idempotencyKey, "blocked", errorCode, startedAt, input),
        );
      }
    } else {
      const verification = await this.eligibility.verify(input.action);
      if (!verification.eligible) {
        const errorCode =
          verification.blockReason === "expired" ? "approval-expired" : "not-authorized";
        return this.persistDecision(
          key,
          receipt(input.action, input.idempotencyKey, "blocked", errorCode, startedAt, input),
        );
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const actionFingerprint = fingerprintToolAction(input.action);
    const externalReconciliationId = scope ? reconciliationId(scope) : undefined;
    let registeredReference: ProviderAttemptReference | undefined;
    const context: ToolExecutionContext = {
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint,
      effectFingerprint,
      correlationId: input.correlationId ?? input.action.requestId,
      source: input.source ?? "tool-execution-service",
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      policyVersion: input.policyVersion ?? "totality-policy:v1",
      registerProviderAttempt: async (reference) => {
        if (!scope || !externalProvider || !externalReconciliationId || !this.reconciliations) {
          throw new Error("Internal tool definitions cannot register external provider attempts.");
        }
        if (reference.provider !== externalProvider) {
          throw new Error("Registered provider does not match the external tool definition.");
        }
        if (
          registeredReference &&
          (registeredReference.providerRequestId !== reference.providerRequestId ||
            registeredReference.providerCorrelationId !== reference.providerCorrelationId)
        ) {
          throw new Error("External tool attempted to register conflicting provider references.");
        }
        const record = await this.reconciliations.registerAttempt({
          ...scope,
          reconciliationId: externalReconciliationId,
          executionKey: key,
          actionId: input.action.actionId,
          requestId: input.action.requestId,
          actionFingerprint,
          reference,
        });
        registeredReference = providerReferenceFromRecord(record) ?? reference;
      },
    };

    try {
      const output = await Promise.race([
        definition.execute(parsed.data, controller.signal, context),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          }),
        ),
      ]);

      if (scope && externalProvider && externalReconciliationId && this.reconciliations) {
        if (!registeredReference) {
          const unresolved = receipt(
            input.action,
            input.idempotencyKey,
            "indeterminate",
            "provider-reference-missing",
            startedAt,
            {
              ...input,
              actionFingerprint,
              effectFingerprint,
              provider: externalProvider,
              reconciliationId: externalReconciliationId,
            },
          );
          const envelope = await this.reconciliations.markIndeterminate({
            ...scope,
            reconciliationId: externalReconciliationId,
            executionKey: key,
            actionId: input.action.actionId,
            requestId: input.action.requestId,
            actionFingerprint,
            expectedProvider: externalProvider,
            receiptKey: key,
            receipt: unresolved,
            missingReferenceReason: "external-success-without-provider-reference",
          });
          if (!envelope.receipt) {
            throw new Error("Missing-reference escalation did not persist a receipt.");
          }
          return envelope.receipt;
        }

        const succeeded: ToolExecutionReceipt = {
          ...receipt(input.action, input.idempotencyKey, "succeeded", undefined, startedAt, {
            ...input,
            actionFingerprint,
            effectFingerprint,
            provider: externalProvider,
            providerRequestId: registeredReference.providerRequestId,
            providerCorrelationId: registeredReference.providerCorrelationId,
            reconciliationId: externalReconciliationId,
          }),
          outputDigest: digest(output),
        };
        const envelope = await this.reconciliations.completeAttempt({
          ...scope,
          reconciliationId: externalReconciliationId,
          executionKey: key,
          actionId: input.action.actionId,
          requestId: input.action.requestId,
          actionFingerprint,
          expectedProvider: externalProvider,
          receiptKey: key,
          receipt: succeeded,
        });
        if (!envelope.receipt) throw new Error("External completion did not persist a receipt.");
        return envelope.receipt;
      }

      const result: ToolExecutionReceipt = {
        ...receipt(input.action, input.idempotencyKey, "succeeded", undefined, startedAt, input),
        outputDigest: digest(output),
      };
      await this.receipts.save(key, result);
      return result;
    } catch (error: unknown) {
      const timedOut = error instanceof Error && error.message === "timeout";
      if (scope && externalProvider && externalReconciliationId && this.reconciliations) {
        if (timedOut || registeredReference) {
          const unresolved = receipt(
            input.action,
            input.idempotencyKey,
            "indeterminate",
            registeredReference ? "indeterminate" : "provider-reference-missing",
            startedAt,
            {
              ...input,
              actionFingerprint,
              effectFingerprint,
              provider: externalProvider,
              ...(registeredReference === undefined
                ? {}
                : {
                    providerRequestId: registeredReference.providerRequestId,
                    providerCorrelationId: registeredReference.providerCorrelationId,
                  }),
              reconciliationId: externalReconciliationId,
            },
          );
          const envelope = await this.reconciliations.markIndeterminate({
            ...scope,
            reconciliationId: externalReconciliationId,
            executionKey: key,
            actionId: input.action.actionId,
            requestId: input.action.requestId,
            actionFingerprint,
            expectedProvider: externalProvider,
            receiptKey: key,
            receipt: unresolved,
            ...(registeredReference === undefined
              ? {
                  missingReferenceReason: "external-timeout-before-provider-reference",
                }
              : {}),
          });
          if (!envelope.receipt) {
            throw new Error("External uncertainty did not persist a receipt.", {
              cause: error,
            });
          }
          return envelope.receipt;
        }
      }

      const result = receipt(
        input.action,
        input.idempotencyKey,
        timedOut ? "indeterminate" : "failed",
        timedOut ? "indeterminate" : "failed",
        startedAt,
        input,
      );
      await this.receipts.save(key, result);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
