/**
 * NOLAN voice — resolving "tick off bar oil" to exactly one open item.
 *
 * The dictation grammar only captures the spoken reference. Before anything is
 * read back, the session asks this resolver which single open task or errand
 * it names, using the same authoritative records the read-only queries use.
 *
 * Safety contract:
 *   - Read-only. It never writes, stages, approves or executes.
 *   - Exactly one match or nothing. An exact title match wins; otherwise the
 *     reference must appear as whole consecutive words of exactly one title.
 *     Two or more equally good matches are refused, never guessed.
 *   - Only open items. A task can only be completed through the governed
 *     `tasks:complete` executor, which acts on tasks inside one project, so a
 *     task is only offered when it belongs to the owner's dedicated voice
 *     project. Any other task is named and refused, with where to complete it.
 *   - Reminders ("cancel the bar oil reminder") resolve the same way, through
 *     the governed `reminders:cancel` executor, so only reminders inside the
 *     dedicated voice project are offered.
 *   - Any source failure fails closed with a plain reason.
 */

import type { ErrandStore } from "../errands/errand.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import type { VoiceCompletionKind } from "./voiceDictation.js";
import type { VoiceWriteTarget } from "./voiceWriteTarget.js";

export type VoiceCompletionTarget = Readonly<{
  kind: "task" | "errand" | "reminder";
  id: string;
  /** The item's full stored title, read back to the owner. */
  title: string;
}>;

export type VoiceCompletionResolution =
  | Readonly<{ status: "found"; target: VoiceCompletionTarget }>
  | Readonly<{ status: "unresolved"; reason: string }>;

export interface VoiceCompletionResolver {
  resolve(input: {
    kind: VoiceCompletionKind;
    reference: string;
  }): Promise<VoiceCompletionResolution>;
}

export const VOICE_COMPLETION_UNAVAILABLE_REASON =
  "Voice completion is unavailable: no task or errand source is connected.";
export const VOICE_RESCHEDULE_DISABLED_REASON =
  "Rescheduling reminders by voice is not enabled yet (AM-017 is planned). Reschedule it on the HUD.";
export const VOICE_REMINDER_CANCEL_UNAVAILABLE_REASON =
  "Voice reminder cancellation is unavailable: no reminder source is connected.";

/** Lower-case words only, so "Bar-oil," and "bar oil" compare equal. */
export function completionMatchKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** 2 for an exact title, 1 when the reference is whole consecutive words of it, 0 otherwise. */
export function completionMatchRank(reference: string, title: string): 0 | 1 | 2 {
  const ref = completionMatchKey(reference);
  const full = completionMatchKey(title);
  if (ref.length === 0 || full.length === 0) return 0;
  if (ref === full) return 2;
  return ` ${full} `.includes(` ${ref} `) ? 1 : 0;
}

type Candidate = Readonly<{
  kind: "task" | "errand" | "reminder";
  id: string;
  title: string;
  /** Whether the governed executor can act on it (tasks and reminders: voice project only). */
  completable: boolean;
}>;

function noun(kind: VoiceCompletionKind): string {
  if (kind === "any") return "task or errand";
  return kind;
}

function notVoiceCaptured(match: Candidate, voiceProjectReason: string | undefined): string {
  if (match.kind === "reminder") {
    return voiceProjectReason
      ? `Reminder “${match.title}” cannot be cancelled by voice: ${voiceProjectReason}`
      : `Reminder “${match.title}” was not captured by voice, so voice cannot cancel it. Cancel it on the HUD.`;
  }
  return voiceProjectReason
    ? `Task “${match.title}” cannot be completed by voice: ${voiceProjectReason}`
    : `Task “${match.title}” was not captured by voice, so voice cannot complete it. Complete it on the HUD.`;
}

export class AuthoritativeVoiceCompletionResolver implements VoiceCompletionResolver {
  readonly #tasks: Pick<PersistenceProvider, "listTasks"> | undefined;
  readonly #errands: Pick<ErrandStore, "list"> | undefined;
  readonly #reminders: Pick<PersistenceProvider, "listReminders"> | undefined;
  readonly #voiceProject: Pick<VoiceWriteTarget, "resolve"> | null | undefined;

  constructor(sources: {
    tasks?: Pick<PersistenceProvider, "listTasks">;
    errands?: Pick<ErrandStore, "list">;
    reminders?: Pick<PersistenceProvider, "listReminders">;
    /** The dedicated voice project; tasks outside it are never offered. */
    voiceProject?: Pick<VoiceWriteTarget, "resolve"> | null;
  }) {
    this.#tasks = sources.tasks;
    this.#errands = sources.errands;
    this.#reminders = sources.reminders;
    this.#voiceProject = sources.voiceProject;
  }

  async resolve(input: {
    kind: VoiceCompletionKind;
    reference: string;
  }): Promise<VoiceCompletionResolution> {
    const wantReminders = input.kind === "reminder";
    const wantTasks = input.kind === "task" || input.kind === "any";
    const wantErrands = input.kind === "errand" || input.kind === "any";
    if (wantReminders && !this.#reminders) {
      return { status: "unresolved", reason: VOICE_REMINDER_CANCEL_UNAVAILABLE_REASON };
    }
    if ((wantTasks && !this.#tasks) || (wantErrands && !this.#errands)) {
      return { status: "unresolved", reason: VOICE_COMPLETION_UNAVAILABLE_REASON };
    }

    let voiceProjectId: string | undefined;
    let voiceProjectReason: string | undefined;
    if (wantTasks || wantReminders) {
      if (this.#voiceProject) {
        try {
          const resolved = await this.#voiceProject.resolve();
          if ("reason" in resolved) voiceProjectReason = resolved.reason;
          else voiceProjectId = resolved.projectId;
        } catch {
          voiceProjectReason = "The voice project could not be read.";
        }
      } else {
        voiceProjectReason = "The voice project is not commissioned.";
      }
    }

    const candidates: Candidate[] = [];
    if (wantTasks) {
      let tasks;
      try {
        tasks = await (this.#tasks as Pick<PersistenceProvider, "listTasks">).listTasks();
      } catch {
        return { status: "unresolved", reason: "Task records are unavailable." };
      }
      for (const task of tasks) {
        if (task.completed) continue;
        candidates.push({
          kind: "task",
          id: task.id,
          title: task.title,
          completable: voiceProjectId !== undefined && task.projectId === voiceProjectId,
        });
      }
    }
    if (wantReminders) {
      let reminders;
      try {
        reminders = await (
          this.#reminders as Pick<PersistenceProvider, "listReminders">
        ).listReminders();
      } catch {
        return { status: "unresolved", reason: "Reminder records are unavailable." };
      }
      // A cancelled reminder is removed from the list, so every listed one is live.
      for (const reminder of reminders) {
        candidates.push({
          kind: "reminder",
          id: reminder.id,
          title: reminder.title,
          completable: voiceProjectId !== undefined && reminder.projectId === voiceProjectId,
        });
      }
    }
    if (wantErrands) {
      let errands;
      try {
        errands = await (this.#errands as Pick<ErrandStore, "list">).list();
      } catch {
        return { status: "unresolved", reason: "Errand records are unavailable." };
      }
      for (const errand of errands) {
        if (errand.status !== "open") continue;
        candidates.push({ kind: "errand", id: errand.id, title: errand.title, completable: true });
      }
    }

    let best = 0;
    let matches: Candidate[] = [];
    for (const candidate of candidates) {
      const rank = completionMatchRank(input.reference, candidate.title);
      if (rank === 0 || rank < best) continue;
      if (rank > best) {
        best = rank;
        matches = [];
      }
      matches.push(candidate);
    }

    const open = wantReminders ? "" : "open ";
    if (matches.length === 0) {
      return {
        status: "unresolved",
        reason: `No ${open}${noun(input.kind)} matches “${input.reference}”.`,
      };
    }
    if (matches.length > 1) {
      return {
        status: "unresolved",
        reason: `${matches.length} ${wantReminders ? "reminders" : "open items"} match “${input.reference}”. Say more of the title.`,
      };
    }
    const [match] = matches as [Candidate];
    if (!match.completable) {
      return { status: "unresolved", reason: notVoiceCaptured(match, voiceProjectReason) };
    }
    return { status: "found", target: { kind: match.kind, id: match.id, title: match.title } };
  }
}
