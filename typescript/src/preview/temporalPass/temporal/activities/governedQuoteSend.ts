import {
  createGovernedExternalOperationFromEnv,
  type GovernedExternalOperation,
} from "../../../../actions/governedExternalOperation.js";
import { QUOTE_SEND_OPERATION, QUOTE_SEND_TOOL } from "../../../../actions/quoteSendTool.js";
import type { ToolAction, ToolActionService } from "../../../../actions/toolActions.js";
import type { ToolExecutionReceipt } from "../../../../actions/toolExecution.js";
import { ConvexToolActionService } from "../../../../persistence/convexToolActions.js";
import type { ToolAuthority } from "../../../../runtime/totalityPolicy.js";
import {
  GOVERNED_QUOTE_SEND_DIR_ENV,
  loadFileBackedGovernedQuoteSendGate,
} from "./governedQuoteSendFileGate.js";

/**
 * The only registered external effect this preview activity may run.
 * `github:merge-pull-request` stays on the mocked merge activity.
 * Live Microsoft Graph commissioning is not performed here.
 */
export const ADMITTED_GOVERNED_TOOL = QUOTE_SEND_TOOL;
export const ADMITTED_GOVERNED_OPERATION = QUOTE_SEND_OPERATION;

export class GovernedQuoteSendUnavailableError extends Error {
  constructor() {
    super(
      "Durable governed quotes:send is unavailable. Convex persistence and the registered quote-send tool are required; refusing without a provider call.",
    );
    this.name = "GovernedQuoteSendUnavailableError";
  }
}

export class GovernedQuoteSendRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernedQuoteSendRefused";
  }
}

export type GovernedQuoteSendGate = {
  propose: GovernedExternalOperation["propose"];
  execute: GovernedExternalOperation["execute"];
  getAction: ToolActionService["get"];
};

export type GovernedQuoteSendProposeInput = {
  mode: "propose";
  proposal: Parameters<GovernedExternalOperation["propose"]>[0];
};

export type GovernedQuoteSendExecuteInput = {
  mode: "execute";
  projectId: string;
  actionId: string;
  authority: ToolAuthority;
  /**
   * Forwarded to the stable boundary. A PolicyEngine allowlist is not
   * authority and is rejected there before any claim or provider call.
   */
  authorityDecision?: unknown;
};

export type GovernedQuoteSendInput = GovernedQuoteSendProposeInput | GovernedQuoteSendExecuteInput;

/**
 * Production wiring is null unless Convex persistence is selected, in which
 * case the stable boundary and the existing Convex ToolAction store are used.
 *
 * `TEMPORAL_PASS_GOVERNED_QUOTE_SEND_DIR` is a test-only seam. It still
 * constructs the real `GovernedExternalOperation` over file-backed claim,
 * receipt, and reconciliation records so a worker can die after accept and
 * a new process can observe that reconciliation. It does not call Microsoft
 * Graph and it is not a second approval store.
 */
export function loadGovernedQuoteSendGateFromEnv(): GovernedQuoteSendGate | null {
  const directory = process.env[GOVERNED_QUOTE_SEND_DIR_ENV]?.trim();
  if (directory) return loadFileBackedGovernedQuoteSendGate(directory);
  const operation = createGovernedExternalOperationFromEnv();
  if (!operation) return null;
  const actions = new ConvexToolActionService();
  return {
    propose: (input) => operation.propose(input),
    execute: (input) => operation.execute(input),
    getAction: (input) => actions.get(input),
  };
}

function assertQuoteSend(action: Pick<ToolAction, "tool" | "operation">): void {
  if (action.tool !== ADMITTED_GOVERNED_TOOL || action.operation !== ADMITTED_GOVERNED_OPERATION) {
    throw new GovernedQuoteSendRefused(
      "Only the registered quotes:send operation is admitted. GitHub merge stays mocked and cannot be executed from this activity.",
    );
  }
}

/**
 * One Temporal activity for the admitted external effect.
 *
 * Propose only stages `quotes:send`. Execute runs only an owner-approved
 * action, once, through `GovernedExternalOperation`. An indeterminate receipt
 * is returned as-is; this function does not call the provider or execute again.
 */
export async function executeGovernedQuoteSend(
  input: GovernedQuoteSendProposeInput,
  loadGate?: () => GovernedQuoteSendGate | null,
): Promise<ToolAction>;
export async function executeGovernedQuoteSend(
  input: GovernedQuoteSendExecuteInput,
  loadGate?: () => GovernedQuoteSendGate | null,
): Promise<ToolExecutionReceipt>;
export async function executeGovernedQuoteSend(
  input: GovernedQuoteSendInput,
  loadGate: () => GovernedQuoteSendGate | null = loadGovernedQuoteSendGateFromEnv,
): Promise<ToolAction | ToolExecutionReceipt> {
  const gate = loadGate();
  if (!gate) throw new GovernedQuoteSendUnavailableError();

  if (input.mode === "propose") {
    assertQuoteSend(input.proposal);
    const staged = await gate.propose(input.proposal);
    if (staged.state !== "proposed") {
      throw new GovernedQuoteSendRefused("Staging a quotes:send action must not approve it.");
    }
    return staged;
  }

  const action = await gate.getAction({
    actionId: input.actionId,
    projectId: input.projectId,
  });
  if (!action) {
    throw new GovernedQuoteSendRefused("Tool action does not exist.");
  }
  assertQuoteSend(action);
  if (action.state !== "approved") {
    throw new GovernedQuoteSendRefused(
      "Owner approval is required before quotes:send. This activity does not approve actions.",
    );
  }

  return gate.execute({
    projectId: input.projectId,
    actionId: input.actionId,
    authority: input.authority,
    ...(input.authorityDecision === undefined
      ? {}
      : { authorityDecision: input.authorityDecision }),
  });
}
