/**
 * Owner decision (24 Nov 2026): low-risk personal voice writes save straight
 * away with a spoken "undo", instead of a spoken confirm plus a ToolAction the
 * owner approves on /settings/approvals.
 *
 * Direct writes: add a task, reminder or errand; mark a task or errand done.
 * Cancelling or rescheduling a reminder and removing an errand keep the
 * confirm-and-approve path, and so does anything that leaves the house
 * (announcements, email, hardware).
 *
 * The write goes to the same stores the governed executors use, with the same
 * argument validation (`safeWriteArguments`), so a direct write can never carry
 * a field the executor would refuse. Each write is recorded once per session
 * as the "last write"; "Nolan undo" reverses only that write, only within the
 * undo window, and only once.
 */

import { randomUUID } from "node:crypto";

import { canonicalJson } from "../actions/canonicalJson.js";
import { sha256Hex } from "../actions/sha256.js";
import type { ErrandStore } from "../errands/errand.js";
import type { ControlledReminderStore } from "../reminders/controlledReminder.js";
import type { ControlledTaskStore, InternalActionContext } from "../tasks/controlledTask.js";
import { JsonErrandStore } from "../errands/jsonErrandStore.js";
import { ConvexControlledReminderStore } from "../persistence/convexControlledReminders.js";
import { ConvexControlledTaskStore } from "../persistence/convexControlledTasks.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { normalizeUtterance, type VoiceCommand } from "./voiceCommands.js";
import { safeWriteArguments, type VoiceWriteCapture } from "./voiceSafeWrite.js";

export const VOICE_DIRECT_SOURCE = "voice-direct";
export const DEFAULT_VOICE_UNDO_WINDOW_MS = 10 * 60 * 1000;

const DIRECT_WRITES = new Set([
  "tasks:create",
  "reminders:create",
  "errands:create",
  "tasks:complete",
  "errands:complete",
]);

/** Phrases that ask to reverse the last direct write (after the wake word). */
const UNDO_PHRASES = new Set(
  ["undo", "undo that", "scratch that", "take that back", "never mind", "nevermind"].map(
    normalizeUtterance,
  ),
);

export function isVoiceUndoPhrase(transcript: string): boolean {
  return UNDO_PHRASES.has(normalizeUtterance(transcript));
}

export function isDirectVoiceWrite(command: VoiceCommand): boolean {
  if (command.kind !== "propose" || !command.proposes) return false;
  return DIRECT_WRITES.has(`${command.proposes.tool}:${command.proposes.operation}`);
}

export type VoiceDirectWriteResult =
  | Readonly<{ status: "saved"; undoExpiresAt: number }>
  | Readonly<{ status: "refused"; reason: string }>;

export type VoiceUndoResult =
  | Readonly<{ status: "undone"; command: VoiceCommand; capture: VoiceWriteCapture }>
  | Readonly<{ status: "unavailable"; reason: string }>;

type LastWrite = {
  command: VoiceCommand;
  capture: VoiceWriteCapture;
  expiresAt: number;
  reverse: () => Promise<boolean>;
};

export const VOICE_UNDO_NOTHING_REASON = "There's nothing recent to undo.";
export const VOICE_UNDO_EXPIRED_REASON = "That was too long ago to undo by voice.";
export const VOICE_UNDO_FAILED_REASON = "I couldn't undo that one. It may have changed since.";
export const VOICE_DIRECT_INCOMPLETE_REASON = "I didn't catch enough to save that.";
export const VOICE_DIRECT_MISSING_REASON = "I couldn't find that item any more.";

export class VoiceDirectWriter {
  readonly #tasks: ControlledTaskStore;
  readonly #reminders: ControlledReminderStore;
  readonly #errands: ErrandStore;
  readonly #clock: () => number;
  readonly #undoWindowMs: number;
  readonly #last = new WeakMap<object, LastWrite>();

  constructor(options: {
    tasks: ControlledTaskStore;
    reminders: ControlledReminderStore;
    errands: ErrandStore;
    clock?: () => number;
    undoWindowMs?: number;
  }) {
    this.#tasks = options.tasks;
    this.#reminders = options.reminders;
    this.#errands = options.errands;
    this.#clock = options.clock ?? Date.now;
    this.#undoWindowMs = options.undoWindowMs ?? DEFAULT_VOICE_UNDO_WINDOW_MS;
  }

  async write(input: {
    /** Identity for the per-session undo slot (the VoiceSession object). */
    session: object;
    sessionId: string;
    projectId: string;
    command: VoiceCommand;
    capture: VoiceWriteCapture;
  }): Promise<VoiceDirectWriteResult> {
    if (!isDirectVoiceWrite(input.command) || !input.command.proposes) {
      return { status: "refused", reason: VOICE_DIRECT_INCOMPLETE_REASON };
    }
    const args = safeWriteArguments(input.command, input.capture);
    if (!args) return { status: "refused", reason: VOICE_DIRECT_INCOMPLETE_REASON };
    const key = `${input.command.proposes.tool}:${input.command.proposes.operation}`;
    const requestId = `voice-direct:${randomUUID()}`;
    const context: InternalActionContext = {
      projectId: input.projectId,
      idempotencyKey: requestId,
      actionFingerprint: `voice-direct:v1:${sha256Hex(canonicalJson({ key, args }))}`,
      sourceRequestId: requestId,
      correlationId: input.sessionId,
      source: VOICE_DIRECT_SOURCE,
    };
    const projectId = input.projectId;
    let reverse: (() => Promise<boolean>) | undefined;

    if (key === "tasks:create") {
      const task = await this.#tasks.create({
        ...context,
        title: args.title as string,
        category: args.category as string,
      });
      reverse = () => this.#tasks.cleanup(projectId, task.id);
    } else if (key === "reminders:create") {
      const reminder = await this.#reminders.create({
        ...context,
        title: args.title as string,
        ...(args.dueRaw === undefined ? {} : { dueRaw: args.dueRaw as string }),
        ...(args.dueAt === undefined ? {} : { dueAt: args.dueAt as number }),
        ...(args.dueTimezone === undefined ? {} : { dueTimezone: args.dueTimezone as string }),
      });
      reverse = () => this.#reminders.cleanup(projectId, reminder.id);
    } else if (key === "errands:create") {
      const errand = await this.#errands.add({ title: args.title as string });
      reverse = async () => (await this.#errands.remove(errand.id)) !== null;
    } else if (key === "tasks:complete") {
      const taskId = args.taskId as string;
      const completed = await this.#tasks.complete({ ...context, taskId });
      if (completed === null) return { status: "refused", reason: VOICE_DIRECT_MISSING_REASON };
      const tasks = this.#tasks;
      if (tasks.reopen) {
        reverse = async () => (await tasks.reopen?.(projectId, taskId)) != null;
      }
    } else if (key === "errands:complete") {
      const errandId = args.errandId as string;
      const before = await this.#errands.get(errandId);
      if (!before || before.status === "done") {
        return { status: "refused", reason: VOICE_DIRECT_MISSING_REASON };
      }
      const done = await this.#errands.update(errandId, { status: "done" });
      if (!done) return { status: "refused", reason: VOICE_DIRECT_MISSING_REASON };
      reverse = async () => (await this.#errands.update(errandId, { status: "open" })) !== null;
    }

    const expiresAt = this.#clock() + this.#undoWindowMs;
    if (reverse) {
      this.#last.set(input.session, {
        command: input.command,
        capture: input.capture,
        expiresAt,
        reverse,
      });
    } else {
      this.#last.delete(input.session);
    }
    return { status: "saved", undoExpiresAt: reverse ? expiresAt : 0 };
  }

  /** Reverse the session's last direct write, at most once. */
  async undo(session: object): Promise<VoiceUndoResult> {
    const last = this.#last.get(session);
    if (!last) return { status: "unavailable", reason: VOICE_UNDO_NOTHING_REASON };
    this.#last.delete(session);
    if (this.#clock() >= last.expiresAt) {
      return { status: "unavailable", reason: VOICE_UNDO_EXPIRED_REASON };
    }
    const reversed = await last.reverse().catch(() => false);
    if (!reversed) return { status: "unavailable", reason: VOICE_UNDO_FAILED_REASON };
    return { status: "undone", command: last.command, capture: last.capture };
  }
}

/** Convex persistence only, like the governed executors that share these stores. */
export function createVoiceDirectWriterFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): VoiceDirectWriter | null {
  if (resolvePersistenceProviderName(environment.PERSISTENCE_PROVIDER) !== "convex") return null;
  return new VoiceDirectWriter({
    tasks: new ConvexControlledTaskStore(),
    reminders: new ConvexControlledReminderStore(),
    errands: new JsonErrandStore(),
  });
}
