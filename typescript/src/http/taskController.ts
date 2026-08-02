import { createHash } from "node:crypto";

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { PersistenceProvider, Task } from "../persistence/persistence.js";
import type { TaskUpdate } from "../persistence/updates.js";
import { JarvisProblem } from "./problemDetails.js";
import { parseCreateTask, parseIdempotencyKey, parseUpdateTask } from "./taskRequest.js";
import { HTTP_PERSISTENCE } from "./tokens.js";

type CachedCreate = { fingerprint: string; task: Task };
type PendingCreate = { fingerprint: string; task: Promise<Task> };
const IDEMPOTENCY_CACHE_LIMIT = 1_000;

function problem(slug: string, title: string, status: number, detail: string): JarvisProblem {
  return new JarvisProblem(status, slug, title, detail);
}

function invalid(detail: string): JarvisProblem {
  return problem("invalid-task", "Invalid Task", HttpStatus.UNPROCESSABLE_ENTITY, detail);
}

function operationProblem(error: unknown): JarvisProblem {
  const message = error instanceof Error ? error.message : String(error);
  if (/controlled task execution/i.test(message)) {
    return problem(
      "controlled-task-boundary",
      "Controlled Task Conflict",
      HttpStatus.CONFLICT,
      "This project-scoped task must be changed through its approved controlled action.",
    );
  }
  if (/task create idempotency key conflict/i.test(message)) {
    return problem(
      "idempotency-conflict",
      "Idempotency Key Conflict",
      HttpStatus.CONFLICT,
      "Idempotency-Key was already used for a different task request.",
    );
  }
  if (/does not exist|not found/i.test(message)) {
    return problem(
      "task-not-found",
      "Task Not Found",
      HttpStatus.NOT_FOUND,
      "The requested task does not exist.",
    );
  }
  return problem(
    "task-persistence-failed",
    "Task Operation Failed",
    HttpStatus.SERVICE_UNAVAILABLE,
    "The configured persistence provider could not complete the task operation.",
  );
}

function taskResponse(task: Task): { data: Task } {
  return { data: task };
}

function requestFingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

@Controller("api/v1/tasks")
export class TaskController {
  private readonly cachedCreates = new Map<string, CachedCreate>();
  private readonly pendingCreates = new Map<string, PendingCreate>();

  constructor(@Inject(HTTP_PERSISTENCE) private readonly persistence: PersistenceProvider) {}

  @Get()
  async list() {
    try {
      const data = await this.persistence.listTasks();
      return { data, count: data.length };
    } catch (error: unknown) {
      throw operationProblem(error);
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = (() => {
      try {
        return parseCreateTask(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The task request is invalid.");
      }
    })();
    let key: string;
    try {
      key = parseIdempotencyKey(request.headers["idempotency-key"]);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "Idempotency-Key is invalid.");
    }
    const fingerprint = requestFingerprint(input);
    const cached = this.cachedCreates.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw problem(
          "idempotency-conflict",
          "Idempotency Key Conflict",
          HttpStatus.CONFLICT,
          "Idempotency-Key was already used for a different task request.",
        );
      }
      reply.header("Location", `/api/v1/tasks/${cached.task.id}`);
      return taskResponse(cached.task);
    }
    const pending = this.pendingCreates.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw problem(
          "idempotency-conflict",
          "Idempotency Key Conflict",
          HttpStatus.CONFLICT,
          "Idempotency-Key was already used for a different task request.",
        );
      }
      const task = await pending.task;
      reply.header("Location", `/api/v1/tasks/${task.id}`);
      return taskResponse(task);
    }
    const create = this.persistence.addTask(input.title, input.category, {
      idempotencyKey: key,
      requestFingerprint: fingerprint,
    });
    this.pendingCreates.set(key, { fingerprint, task: create });
    try {
      const task = await create;
      this.cachedCreates.set(key, { fingerprint, task });
      while (this.cachedCreates.size > IDEMPOTENCY_CACHE_LIMIT) {
        const oldestKey = this.cachedCreates.keys().next().value;
        if (oldestKey === undefined) break;
        this.cachedCreates.delete(oldestKey);
      }
      reply.header("Location", `/api/v1/tasks/${task.id}`);
      return taskResponse(task);
    } catch (error: unknown) {
      throw operationProblem(error);
    } finally {
      this.pendingCreates.delete(key);
    }
  }

  @Get(":taskId")
  async get(@Param("taskId") taskId: string) {
    try {
      const task = (await this.persistence.listTasks()).find((item) => item.id === taskId);
      if (!task) throw new Error("Task does not exist.");
      return taskResponse(task);
    } catch (error: unknown) {
      throw operationProblem(error);
    }
  }

  @Patch(":taskId")
  async update(@Param("taskId") taskId: string, @Body() body: unknown) {
    let input: TaskUpdate;
    try {
      input = parseUpdateTask(body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The task update is invalid.");
    }
    try {
      const task = await this.persistence.updateTask(taskId, input);
      if (!task) throw new Error("Task does not exist.");
      return taskResponse(task);
    } catch (error: unknown) {
      throw operationProblem(error);
    }
  }

  @Delete(":taskId")
  async remove(@Param("taskId") taskId: string) {
    try {
      const task = await this.persistence.removeTask(taskId);
      if (!task) throw new Error("Task does not exist.");
      return taskResponse(task);
    } catch (error: unknown) {
      throw operationProblem(error);
    }
  }

  @Post(":taskId/complete")
  async complete(@Param("taskId") taskId: string) {
    try {
      const task = await this.persistence.completeTask(taskId);
      if (!task) throw new Error("Task does not exist.");
      return taskResponse(task);
    } catch (error: unknown) {
      throw operationProblem(error);
    }
  }
}
