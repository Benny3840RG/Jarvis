import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import type { ToolActionService } from "../actions/toolActions.js";
import { JarvisProblem } from "./problemDetails.js";
import { requestIdFor } from "./requestId.js";
import {
  parseStageToolAction,
  parseToolActionExpectedRevision,
  parseToolActionListLimit,
  parseToolActionRejectionReason,
  parseToolActionState,
} from "./toolActionRequest.js";
import { HTTP_TOOL_ACTIONS } from "./tokens.js";

function unavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "tool-action-approval-unavailable",
    "Tool Action Approval Unavailable",
    "Tool action approval requires the configured Convex persistence provider.",
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
    /cannot be|already exists with different|already has a different|requires T3|requires authority T1/i.test(
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
  ) {}

  private requireService(): ToolActionService {
    if (!this.service) throw unavailable();
    return this.service;
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
    let expectedRevision;
    try {
      expectedRevision = parseToolActionExpectedRevision(body);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-tool-action-approval",
        "Invalid Tool Action Approval",
        "Tool action approval requires a valid expected project revision.",
      );
    }
    try {
      return await this.requireService().approve({ actionId, projectId, expectedRevision });
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
}
