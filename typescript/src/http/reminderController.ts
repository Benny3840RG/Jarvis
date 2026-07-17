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

import type { PersistenceProvider, Reminder } from "../persistence/persistence.js";
import { JarvisProblem } from "./problemDetails.js";
import { parseCreateReminder, parseUpdateReminder } from "./reminderRequest.js";
import { parseIdempotencyKey } from "./taskRequest.js";
import { HTTP_PERSISTENCE } from "./tokens.js";

type CachedCreate = { fingerprint: string; reminder: Reminder };
type PendingCreate = { fingerprint: string; reminder: Promise<Reminder> };
const IDEMPOTENCY_CACHE_LIMIT = 1_000;

function problem(slug: string, title: string, status: number, detail: string): JarvisProblem {
  return new JarvisProblem(status, slug, title, detail);
}

function invalid(detail: string): JarvisProblem {
  return problem("invalid-reminder", "Invalid Reminder", HttpStatus.UNPROCESSABLE_ENTITY, detail);
}

function operationProblem(error: unknown): JarvisProblem {
  const message = error instanceof Error ? error.message : String(error);
  if (/does not exist|not found/i.test(message)) {
    return problem(
      "reminder-not-found",
      "Reminder Not Found",
      HttpStatus.NOT_FOUND,
      "The requested reminder does not exist.",
    );
  }
  return problem(
    "reminder-persistence-failed",
    "Reminder Operation Failed",
    HttpStatus.SERVICE_UNAVAILABLE,
    "The configured persistence provider could not complete the reminder operation.",
  );
}

function reminderResponse(reminder: Reminder): { data: Reminder } {
  return { data: reminder };
}

@Controller("api/v1/reminders")
export class ReminderController {
  private readonly cachedCreates = new Map<string, CachedCreate>();
  private readonly pendingCreates = new Map<string, PendingCreate>();

  constructor(@Inject(HTTP_PERSISTENCE) private readonly persistence: PersistenceProvider) {}

  @Get()
  async list() {
    try {
      const data = await this.persistence.listReminders();
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
    let input: { title: string; due?: import("../persistence/persistence.js").ReminderDue };
    try {
      input = parseCreateReminder(body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The reminder request is invalid.");
    }
    let key: string;
    try {
      key = parseIdempotencyKey(request.headers["idempotency-key"]);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "Idempotency-Key is invalid.");
    }
    const fingerprint = JSON.stringify(input);
    const cached = this.cachedCreates.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw problem(
          "idempotency-conflict",
          "Idempotency Key Conflict",
          HttpStatus.CONFLICT,
          "Idempotency-Key was already used for a different reminder request.",
        );
      }
      reply.header("Location", `/api/v1/reminders/${cached.reminder.id}`);
      return reminderResponse(cached.reminder);
    }
    const pending = this.pendingCreates.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw problem(
          "idempotency-conflict",
          "Idempotency Key Conflict",
          HttpStatus.CONFLICT,
          "Idempotency-Key was already used for a different reminder request.",
        );
      }
      const reminder = await pending.reminder;
      reply.header("Location", `/api/v1/reminders/${reminder.id}`);
      return reminderResponse(reminder);
    }
    const create = this.persistence.addReminder(input.title, input.due);
    this.pendingCreates.set(key, { fingerprint, reminder: create });
    try {
      const reminder = await create;
      this.cachedCreates.set(key, { fingerprint, reminder });
      while (this.cachedCreates.size > IDEMPOTENCY_CACHE_LIMIT) {
        const oldestKey = this.cachedCreates.keys().next().value;
        if (oldestKey === undefined) break;
        this.cachedCreates.delete(oldestKey);
      }
      reply.header("Location", `/api/v1/reminders/${reminder.id}`);
      return reminderResponse(reminder);
    } catch (error: unknown) {
      throw operationProblem(error);
    } finally {
      this.pendingCreates.delete(key);
    }
  }

  @Get(":reminderId")
  async get(@Param("reminderId") reminderId: string) {
    try {
      const reminder = (await this.persistence.listReminders()).find(
        (item) => item.id === reminderId,
      );
      if (!reminder) throw new Error("Reminder does not exist.");
      return reminderResponse(reminder);
    } catch (error: unknown) {
      throw operationProblem(error);
    }
  }

  @Patch(":reminderId")
  async update(@Param("reminderId") reminderId: string, @Body() body: unknown) {
    let input;
    try {
      input = parseUpdateReminder(body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The reminder update is invalid.");
    }
    try {
      const reminder = await this.persistence.updateReminder(reminderId, input);
      if (!reminder) throw new Error("Reminder does not exist.");
      return reminderResponse(reminder);
    } catch (error: unknown) {
      throw operationProblem(error);
    }
  }

  @Delete(":reminderId")
  async remove(@Param("reminderId") reminderId: string) {
    try {
      const reminder = await this.persistence.removeReminder(reminderId);
      if (!reminder) throw new Error("Reminder does not exist.");
      return reminderResponse(reminder);
    } catch (error: unknown) {
      throw operationProblem(error);
    }
  }
}
