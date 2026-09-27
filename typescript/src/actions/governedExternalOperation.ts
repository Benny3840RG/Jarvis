import {
  createGovernedAcpConsultationFromEnv,
  type AcpConsultationEvidence,
  type GovernedAcpConsultation,
} from "../acp/acpGovernedConsultation.js";
import type { QuoteEmailProvider } from "../quotes/quoteEmailProvider.js";
import { createQuoteEmailProviderFromEnv } from "../quotes/quoteEmailProvider.js";
import { ConvexExternalReconciliationStore } from "../persistence/convexExternalReconciliations.js";
import { ConvexToolActionService } from "../persistence/convexToolActions.js";
import type { ExternalReconciliationStore } from "../reconciliation/externalReconciliation.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";
import type { GitHubDevelopmentClient } from "../development/githubDevelopment.js";
import { createGitHubDevelopmentClientFromEnv } from "../development/githubDevelopment.js";
import type { GoogleHomeAnnouncementProvider } from "../integrations/googleHome/googleHomeAnnouncementProvider.js";
import { createGoogleHomeAnnouncementProviderFromEnv } from "../integrations/googleHome/googleHomeAnnouncementProvider.js";
import type { ToolAction, ToolActionService } from "./toolActions.js";
import { createToolExecutionServiceFromEnv } from "./toolExecutionFactory.js";
import {
  deriveToolExecutionIdempotencyKey,
  ToolExecutionService,
  type ToolExecutionReceipt,
} from "./toolExecution.js";

/**
 * The only authority token a later Temporal activity may pass into this
 * boundary. A preview PolicyEngine allowlist is not this token.
 */
export const GOVERNED_EXTERNAL_OPERATION_BOUNDARY = "omega-tool-action-claim-receipt:v1" as const;

export class PolicyEngineNotAuthorityError extends Error {
  constructor() {
    super(
      "PolicyEngine allowlists are not execution authority. External effects must use the ToolAction claim, receipt, and reconciliation boundary.",
    );
    this.name = "PolicyEngineNotAuthorityError";
  }
}

export class GovernedExternalOperationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernedExternalOperationRefused";
  }
}

/**
 * Raised when an ACP consultation blocks the operation *before* the external
 * effect (a `required`-mode `deny`/failure, or a mode that blocks an
 * unauthorised action). A subclass of {@link GovernedExternalOperationRefused},
 * so callers that already catch that base type handle it unchanged. It is thrown
 * before `ToolExecutionService.execute`, so the external provider is never
 * invoked and no single-use claim is consumed. Carries the consultation evidence.
 */
export class AcpConsultationBlockedError extends GovernedExternalOperationRefused {
  readonly evidence: AcpConsultationEvidence;

  constructor(evidence: AcpConsultationEvidence) {
    super(`ACP consultation blocked the operation (${evidence.mode}): ${evidence.reason}`);
    this.name = "AcpConsultationBlockedError";
    this.evidence = evidence;
  }
}

/**
 * Fail closed unless the caller omitted an authority decision or named this
 * boundary. Any PolicyEngine allowlist, boolean allow, or other object is
 * refused before a claim or an external effect.
 */
export function assertNotPolicyEngineAuthority(authority: unknown): void {
  if (authority === undefined || authority === GOVERNED_EXTERNAL_OPERATION_BOUNDARY) return;
  throw new PolicyEngineNotAuthorityError();
}

export type GovernedExternalOperationPorts = {
  readonly actions: Pick<ToolActionService, "stage" | "get">;
  readonly execution: ToolExecutionService;
  readonly reconciliations: ExternalReconciliationStore;
  /**
   * Optional ACP governed consultation. Absent, or in `disabled` mode (the
   * default), the boundary behaves exactly as before — no worker launches and no
   * consultation runs. `advisory`/`required` change behaviour only when an owner
   * has provisioned the mode and a worker.
   */
  readonly acp?: GovernedAcpConsultation;
  /**
   * Optional observer for consultation evidence — the telemetry/audit seam. Runs
   * on every consultation (including advisory disagreements and failures), so
   * evidence is never silently discarded.
   */
  readonly onAcpConsultation?: (evidence: AcpConsultationEvidence) => void;
};

export type GovernedExternalExecuteInput = {
  projectId: string;
  actionId: string;
  authority: ToolAuthority;
  dryRun?: boolean;
  timeoutMs?: number;
  correlationId?: string;
  /**
   * Optional acknowledgement of this boundary. Any other value, including a
   * PolicyEngine allowlist, is refused.
   */
  authorityDecision?: unknown;
};

/**
 * Stable adapter a later Temporal activity must call for one external effect.
 * It does not approve, merge, or decide policy. It reloads the ToolAction,
 * then delegates to `ToolExecutionService`, which claims a single-use action
 * or verifies a reusable action before the effect, writes the receipt, and
 * schedules reconciliation for an indeterminate external outcome.
 */
export class GovernedExternalOperation {
  constructor(private readonly ports: GovernedExternalOperationPorts) {
    if (ports.execution.usesFailOpenExecutionGate()) {
      throw new GovernedExternalOperationRefused(
        "External effects require the authoritative ToolAction claim and eligibility stores, not the fail-open in-memory defaults.",
      );
    }
  }

  /** Stage a proposal. Approval stays on the existing owner path. */
  propose(input: Parameters<ToolActionService["stage"]>[0]): Promise<ToolAction> {
    return this.ports.actions.stage(input);
  }

  async execute(input: GovernedExternalExecuteInput): Promise<ToolExecutionReceipt> {
    assertNotPolicyEngineAuthority(input.authorityDecision);
    const action = await this.ports.actions.get({
      actionId: input.actionId,
      projectId: input.projectId,
    });
    if (!action) {
      throw new GovernedExternalOperationRefused("Tool action does not exist.");
    }
    if (this.ports.execution.externalProviderFor(action.tool, action.operation) === undefined) {
      throw new GovernedExternalOperationRefused(
        "This boundary only admits a registered external operation.",
      );
    }
    if (action.consumptionPolicy !== "single-use" && action.consumptionPolicy !== "reusable") {
      throw new GovernedExternalOperationRefused(
        "External effects require an explicit single-use or reusable consumption policy.",
      );
    }

    // ACP consultation runs BEFORE the effect (and before any single-use claim),
    // so a required-mode block never invokes the provider and never consumes an
    // approval. Dormant unless an owner enabled a mode and a worker.
    await this.consultAcpBeforeExecution(action, input);

    const dryRun = input.dryRun === true;
    const receipt = await this.ports.execution.execute({
      action,
      authority: input.authority,
      idempotencyKey: deriveToolExecutionIdempotencyKey(
        action.actionId,
        dryRun ? "dry-run" : "live",
      ),
      approvalId: action.actionId,
      policyVersion:
        typeof action.arguments.policyDecisionFingerprint === "string"
          ? action.arguments.policyDecisionFingerprint
          : "totality-policy:v1",
      correlationId: input.correlationId ?? action.requestId,
      source: "governed-external-operation",
      ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });

    if (!receipt.receiptId) {
      throw new GovernedExternalOperationRefused("Terminal outcome did not write a receipt.");
    }
    if (receipt.status === "indeterminate") {
      await this.requireScheduledReconciliation(action, receipt);
    }
    return receipt;
  }

  /**
   * Consult ACP under the configured operating mode, if any. Blocks by throwing
   * {@link AcpConsultationBlockedError} before the effect when the mode policy
   * refuses; otherwise records evidence and returns so execution proceeds.
   *
   * The governed-approval signal is derived from the ToolAction's own
   * server-computed approval state — NOT from the caller's `ToolAuthority`, and
   * NOT by consuming the single-use claim. This is a *non-consuming* eligibility
   * read placed in front of the authoritative execution-time gate; that gate
   * (the atomic claim / eligibility re-check inside `ToolExecutionService`) still
   * re-validates the same fact immediately before the effect, so this earlier
   * read never becomes the authority and the final boundary stays race-safe.
   */
  private async consultAcpBeforeExecution(
    action: ToolAction,
    input: GovernedExternalExecuteInput,
  ): Promise<void> {
    const acp = this.ports.acp;
    if (!acp || acp.mode === "disabled") return;
    const governedApprovalPresent =
      action.state === "approved" && action.isApprovalExpired !== true;
    const correlationId = input.correlationId ?? action.requestId;
    const evidence = await acp.consult(
      {
        requestId: action.requestId,
        action: `${action.tool}:${action.operation}`,
        detail: correlationId,
      },
      governedApprovalPresent,
    );
    // The observer is a best-effort telemetry/audit seam; isolate its
    // exceptions so a throwing observer cannot change the authority decision
    // (e.g. abort a would-be-proceeding operation before its effect).
    if (this.ports.onAcpConsultation) {
      try {
        this.ports.onAcpConsultation(evidence);
      } catch {
        // Swallow: evidence is advisory observability, not the authority record.
      }
    }
    if (!evidence.proceed) {
      throw new AcpConsultationBlockedError(evidence);
    }
  }

  private async requireScheduledReconciliation(
    action: ToolAction,
    receipt: ToolExecutionReceipt,
  ): Promise<void> {
    if (!receipt.reconciliationId || !receipt.effectFingerprint) {
      throw new GovernedExternalOperationRefused(
        "Indeterminate external outcome has no scheduled reconciliation.",
      );
    }
    const envelope = await this.ports.reconciliations.getByScope({
      projectId: action.projectId,
      tool: action.tool,
      operation: action.operation,
      idempotencyKey: receipt.idempotencyKey,
      effectFingerprint: receipt.effectFingerprint,
    });
    if (!envelope?.reconciliation.reconciliationId) {
      throw new GovernedExternalOperationRefused(
        "Indeterminate external outcome has no scheduled reconciliation.",
      );
    }
  }
}

/**
 * Production wiring. Returns null unless Convex persistence is selected, in
 * which case the existing Convex ToolAction, receipt, and reconciliation
 * stores are the only gates. This does not register a new external effect.
 */
export function createGovernedExternalOperationFromEnv(
  quoteEmailProvider: QuoteEmailProvider | null = createQuoteEmailProviderFromEnv(),
  githubDevelopmentClient: GitHubDevelopmentClient | null = createGitHubDevelopmentClientFromEnv(),
  googleHomeAnnouncementProvider: GoogleHomeAnnouncementProvider | null = createGoogleHomeAnnouncementProviderFromEnv(),
): GovernedExternalOperation | null {
  const execution = createToolExecutionServiceFromEnv(
    quoteEmailProvider,
    githubDevelopmentClient,
    googleHomeAnnouncementProvider,
  );
  if (!execution) return null;
  return new GovernedExternalOperation({
    actions: new ConvexToolActionService(),
    execution,
    reconciliations: new ConvexExternalReconciliationStore(),
    // Dormant-first: resolves to `disabled` (no consult, no worker) unless an
    // owner sets JARVIS_ACP_MODE and a JARVIS_ACP_WORKER_* command.
    acp: createGovernedAcpConsultationFromEnv(),
  });
}
