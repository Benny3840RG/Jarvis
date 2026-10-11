/**
 * Concrete read-only voice query provider (#567, Stage 3).
 *
 * Answers the client/workshop *business* query commands from Jarvis's existing
 * authoritative daily-brief projection — the same `DailyBrief` the HUD renders.
 * It is fully deterministic: a command id maps to a fixed read of the brief and
 * a plain-language answer. There is no LLM interpreting storage, and no second
 * data layer; the brief reader is supplied by the caller so this stays a pure
 * mapping that is unit-testable without any host or persistence.
 *
 * Equipment status queries (crawler/workshop/trailer `*.status`) are NOT
 * business data, so this provider reports them unavailable rather than
 * guessing — a hardware-status provider answers those when one is connected.
 */

import type { DailyBrief } from "../briefs/brief.js";
import type { Project } from "../projects/project.js";
import type { VoiceQueryProvider, VoiceQueryRequest, VoiceQueryResult } from "./voiceQuery.js";

/** Reads the current authoritative daily brief. Supplied by the caller. */
export type DailyBriefReader = () => Promise<DailyBrief>;

/** How many jobs to name before collapsing the rest into "and N more". */
const NAMED_JOB_CAP = 3;

function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Name up to {@link NAMED_JOB_CAP} jobs, collapsing any remainder. */
function nameJobs(jobs: readonly Project[]): string {
  const named = jobs.slice(0, NAMED_JOB_CAP).map((job) => job.title);
  const remainder = jobs.length - named.length;
  const list = named.join(", ");
  return remainder > 0 ? `${list}, and ${countNoun(remainder, "more", "more")}` : list;
}

/** The next booked job: today's first, else this week's first, else none. */
function nextBookedJob(brief: DailyBrief): Project | undefined {
  return brief.scheduled.today[0] ?? brief.scheduled.thisWeek[0];
}

function describeNextJob(brief: DailyBrief, noneMessage: string, lead: string): string {
  const job = nextBookedJob(brief);
  if (!job) return noneMessage;
  const when = job.scheduledFor ? ` on ${job.scheduledFor}` : "";
  return `${lead}: ${job.title}${when}.`;
}

/**
 * Deterministic answerers keyed by command id. A command absent here is not
 * backed by the brief read model and is reported unavailable, never guessed.
 */
const ANSWERERS: Readonly<Record<string, (brief: DailyBrief) => string>> = Object.freeze({
  "client.unpaid-invoices": (brief) =>
    brief.invoices.unpaidCount === 0
      ? "No unpaid invoices."
      : `${countNoun(brief.invoices.unpaidCount, "unpaid invoice")}.`,
  "client.open-enquiries": (brief) =>
    brief.enquiries.openCount === 0
      ? "No open enquiries."
      : `${countNoun(brief.enquiries.openCount, "open enquiry", "open enquiries")}.`,
  "client.todays-schedule": (brief) =>
    brief.scheduled.todayCount === 0
      ? "Nothing scheduled for today."
      : `${countNoun(brief.scheduled.todayCount, "job")} today: ${nameJobs(brief.scheduled.today)}.`,
  "client.next-appointment": (brief) =>
    describeNextJob(brief, "No upcoming appointments are scheduled.", "Next appointment"),
  "workshop.next-job": (brief) => describeNextJob(brief, "No jobs are scheduled.", "Next job"),
});

export class DailyBriefVoiceQueryProvider implements VoiceQueryProvider {
  readonly #readBrief: DailyBriefReader;

  constructor(readBrief: DailyBriefReader) {
    this.#readBrief = readBrief;
  }

  async answer(request: VoiceQueryRequest): Promise<VoiceQueryResult> {
    const answerer = ANSWERERS[request.commandId];
    if (!answerer) {
      return {
        status: "unavailable",
        commandId: request.commandId,
        reason: "This query is not backed by the daily brief read model.",
      };
    }
    let brief: DailyBrief;
    try {
      brief = await this.#readBrief();
    } catch {
      // Never fabricate an answer when the read model cannot be read.
      return {
        status: "failed",
        commandId: request.commandId,
        reason: "The daily brief read model could not be read.",
      };
    }
    return { status: "answered", commandId: request.commandId, answer: answerer(brief) };
  }
}
