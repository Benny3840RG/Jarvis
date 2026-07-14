import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import type { MemoryChangeSetService } from "../memory/memoryChangeSets.js";
import { JarvisProblem } from "./problemDetails.js";
import { requestIdFor } from "./requestId.js";
import {
  parseExpectedRevision,
  parseListLimit,
  parseMemoryChangeSetState,
  parseRejectionReason,
  parseStageMemoryChangeSet,
} from "./memoryChangeSetRequest.js";
import { HTTP_MEMORY_CHANGE_SETS } from "./tokens.js";

function unavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "memory-approval-unavailable",
    "Memory Approval Unavailable",
    "Memory approval requires the configured Convex persistence provider.",
  );
}

function operationProblem(error: unknown): JarvisProblem {
  const message = error instanceof Error ? error.message : String(error);
  if (/does not exist|is missing/i.test(message)) {
    return new JarvisProblem(
      404,
      "memory-change-set-not-found",
      "Memory Change Set Not Found",
      "The requested memory change set or project does not exist.",
    );
  }
  if (/revision conflict/i.test(message)) {
    return new JarvisProblem(
      409,
      "memory-revision-conflict",
      "Memory Revision Conflict",
      "The project revision changed before this memory operation could be completed.",
    );
  }
  if (
    /cannot be|only approved|already exists with different|conflicting|duplicate/i.test(message)
  ) {
    return new JarvisProblem(
      409,
      "memory-state-conflict",
      "Memory State Conflict",
      "The memory change set cannot complete from its current state.",
    );
  }
  return new JarvisProblem(
    503,
    "memory-approval-failed",
    "Memory Approval Failed",
    "The memory approval operation could not be safely completed.",
  );
}

@Controller("api/v1/projects/:projectId/memory-change-sets")
export class MemoryChangeSetController {
  constructor(
    @Inject(HTTP_MEMORY_CHANGE_SETS)
    private readonly service: MemoryChangeSetService | null,
  ) {}

  private requireService(): MemoryChangeSetService {
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
      parsed = parseStageMemoryChangeSet(body);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-memory-change-set",
        "Invalid Memory Change Set",
        "The memory change set does not match the supported contract.",
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
      state = parseMemoryChangeSetState(stateValue);
      limit = parseListLimit(limitValue);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-memory-query",
        "Invalid Memory Query",
        "The memory change set query is not supported.",
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

  @Get(":changeSetId")
  async get(@Param("changeSetId") changeSetId: string) {
    try {
      const changeSet = await this.requireService().get(changeSetId);
      if (!changeSet) throw operationProblem(new Error("Memory change set does not exist."));
      return changeSet;
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":changeSetId/approve")
  @HttpCode(200)
  async approve(@Param("changeSetId") changeSetId: string, @Body() body: unknown) {
    let expectedRevision;
    try {
      expectedRevision = parseExpectedRevision(body);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-memory-approval",
        "Invalid Memory Approval",
        "Memory approval requires a valid expected project revision.",
      );
    }
    try {
      return await this.requireService().approve({ changeSetId, expectedRevision });
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":changeSetId/reject")
  @HttpCode(200)
  async reject(@Param("changeSetId") changeSetId: string, @Body() body: unknown) {
    let reason;
    try {
      reason = parseRejectionReason(body);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-memory-rejection",
        "Invalid Memory Rejection",
        "Memory rejection requires a non-empty reason.",
      );
    }
    try {
      return await this.requireService().reject({ changeSetId, reason });
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":changeSetId/apply")
  @HttpCode(200)
  async apply(@Param("changeSetId") changeSetId: string, @Body() body: unknown) {
    let expectedRevision;
    try {
      expectedRevision = parseExpectedRevision(body);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-memory-apply",
        "Invalid Memory Apply",
        "Memory apply requires a valid expected project revision.",
      );
    }
    try {
      return await this.requireService().apply({ changeSetId, expectedRevision });
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }
}
