import { createHash, timingSafeEqual } from "node:crypto";

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import type { ToolActionService } from "../actions/toolActions.js";
import {
  deriveToolExecutionIdempotencyKey,
  type ToolExecutionService,
} from "../actions/toolExecution.js";
import type { HttpAppConfig } from "./config.js";
import { JarvisProblem } from "./problemDetails.js";
import { requestIdFor } from "./requestId.js";
import {
  parseExecuteToolAction,
  parseStageToolAction,
  parseToolActionApproval,
  parseToolActionListLimit,
  parseToolActionRejectionReason,
  parseToolActionState,
} from "./toolActionRequest.js";
import { HTTP_APP_CONFIG, HTTP_TOOL_ACTIONS, HTTP_TOOL_EXECUTION } from "./tokens.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function matchesApprovalToken(
  candidate: string,
  currentToken: string,
  previousToken: string | undefined,
): boolean {
  const candidateDigest = digest(candidate);
  const currentMatch = timingSafeEqual(candidateDigest, digest(currentToken));
  const previousMatch =
    previousToken === undefined ? false : timingSafeEqual(candidateDigest, digest(previousToken));
  return currentMatch || previousMatch;
}

function approvalUnavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "tool-action-approval-token-unavailable",
    "Tool Action Approval Token Unavailable",
    "Tool action approval requires a separately configured approval token.",
  );
}

function approvalUnauthorized(): JarvisProblem {
  return new JarvisProblem(
    401,
    "unauthorized",
    "Unauthorized",
    "A valid approval token is required to approve a tool action.",
  );
}

function unavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "tool-action-approval-unavailable",
    "Tool Action Approval Unavailable",
    "Tool action approval requires the configured Convex persistence provider.",
  );
}

function executionUnavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "tool-action-execution-unavailable",
    "Tool Action Execution Unavailable",
    "Tool action execution requires the configured Convex persistence provider.",
  );
}

function operationProblem(error: unknown): JarvisProblem {
  const message = error instanceof Error ? error.message : String(error);
  if (/does not exist|is missing/i.test(message)) {
    return new JarvisProblem(
      404,
      "tool-action-not-found",
      "Tool Action Not Found",
      "The requested tool action or project does not exist.",
    );
  }
  if (/revision conflict/i.test(message)) {
    return new JarvisProblem(
      409,
      "tool-action-revision-conflict",
      "Tool Action Revision Conflict",
      "The project revision changed before this tool action operation could be completed.",
    );
  }
  if (
    /cannot be|already exists with different|already has a different|already belongs to another action|requires T3|requires authority T1/i.test(
      message,
    )
  ) {
    return new JarvisProblem(
      409,
      "tool-action-state-conflict",
      "Tool Action State Conflict",
      "The tool action cannot complete from its current state or authority envelope.",
    );
  }
  return new JarvisProblem(
    503,
    "tool-action-approval-failed",
    "Tool Action Approval Failed",
    "The tool action approval operation could not be safely completed.",
  );
}

@Controller("api/v1/projects/:projectId/tool-actions")
export class ToolActionController {
  constructor(
    @Inject(HTTP_TOOL_ACTIONS)
    private readonly service: ToolActionService | null,
    @Inject(HTTP_TOOL_EXECUTION)
    private readonly executionService: ToolExecutionService | null,
    @Inject(HTTP_APP_CONFIG)
    private readonly config: HttpAppConfig,
  ) {}

  private requireService(): ToolActionService {
    if (!this.service) throw unavailable();
    return this.service;
  }

  private requireExecutionService(): ToolExecutionService {
    if (!this.executionService) throw executionUnavailable();
    return this.executionService;
  }

  // Staging, listing, and execution are gated only by the shared Bearer
  // service token, so that same credential proves nothing about who decided
  // to approve a specific proposal. approvalToken is a second, separately
  // configured secret that only the human operator holds; requiring it here
  // (and nowhere else) is what makes reaching "approved" actual proof of a
  // human decision rather than just another authenticated API call.
  private requireApprovalToken(candidate: string): void {
    if (!this.config.currentApprovalToken) throw approvalUnavailable();
    if (
      !matchesApprovalToken(
        candidate,
        this.config.currentApprovalToken,
        this.config.previousApprovalToken,
      )
    ) {
      throw approvalUnauthorized();
    }
  }

  @Post()
  @HttpCode(201)
  async stage(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    let parsed;
    try {
      parsed = parseStageToolAction(body);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-tool-action",
        "Invalid Tool Action",
        "The tool action proposal does not match the supported contract.",
      );
    }
    try {
      return await this.requireService().stage({
        ...parsed,
        projectId,
        requestId: requestIdFor(request),
      });
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Get()
  async list(
    @Param("projectId") projectId: string,
    @Query("state") stateValue: unknown,
    @Query("limit") limitValue: unknown,
  ) {
    let state;
    let limit;
    try {
      state = parseToolActionState(stateValue);
      limit = parseToolActionListLimit(limitValue);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-tool-action-query",
        "Invalid Tool Action Query",
        "The tool action query is not supported.",
      );
    }
    try {
      return await this.requireService().list({
        projectId,
        ...(state === undefined ? {} : { state }),
        ...(limit === undefined ? {} : { limit }),
      });
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Get(":actionId")
  async get(@Param("projectId") projectId: string, @Param("actionId") actionId: string) {
    try {
      const action = await this.requireService().get({ actionId, projectId });
      if (!action) throw operationProblem(new Error("Tool action does not exist."));
      return action;
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":actionId/approve")
  @HttpCode(200)
  async approve(
    @Param("projectId") projectId: string,
    @Param("actionId") actionId: string,
    @Body() body: unknown,
  ) {
    let parsed;
    try {
      parsed = parseToolActionApproval(body);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-tool-action-approval",
        "Invalid Tool Action Approval",
        "Tool action approval requires a valid expected project revision and approval token.",
      );
    }
    this.requireApprovalToken(parsed.approvalToken);
    try {
      return await this.requireService().approve({
        actionId,
        projectId,
        expectedRevision: parsed.expectedRevision,
      });
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":actionId/reject")
  @HttpCode(200)
  async reject(
    @Param("projectId") projectId: string,
    @Param("actionId") actionId: string,
    @Body() body: unknown,
  ) {
    let reason;
    try {
      reason = parseToolActionRejectionReason(body);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-tool-action-rejection",
        "Invalid Tool Action Rejection",
        "Tool action rejection requires a non-empty reason.",
      );
    }
    try {
      return await this.requireService().reject({ actionId, projectId, reason });
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":actionId/execute")
  @HttpCode(200)
  async execute(
    @Param("projectId") projectId: string,
    @Param("actionId") actionId: string,
    @Body() body: unknown,
  ) {
    let parsed;
    try {
      parsed = parseExecuteToolAction(body);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-tool-action-execution",
        "Invalid Tool Action Execution",
        "Tool action execution requires a valid idempotencyKey.",
      );
    }
    let action;
    try {
      action = await this.requireService().get({ actionId, projectId });
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
    if (!action) throw operationProblem(new Error("Tool action does not exist."));

    // The shared Bearer service token gates every request this controller
    // serves, including this one — there is no separate per-caller authority
    // signal at execute time. T3 is therefore the ceiling any authenticated
    // caller may assert here; the real gate already happened when the action
    // reached "approved", which (see requireApprovalToken above) requires a
    // second, separately configured credential that only the human operator
    // holds — staging or executing alone cannot get an action there. Beyond
    // that, ToolExecutionService still re-checks the acting authority against
    // the action's own requiredAuthority before doing anything else.
    return this.requireExecutionService().execute({
      action,
      authority: "T3",
      idempotencyKey: deriveToolExecutionIdempotencyKey(
        action.actionId,
        parsed.dryRun === true ? "dry-run" : "live",
      ),
      ...(parsed.dryRun === undefined ? {} : { dryRun: parsed.dryRun }),
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    });
  }
}
