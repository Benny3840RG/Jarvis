export type ActivityActor = "user" | "agent" | "tool";

export interface RawActivityEvent {
  activityId: string;
  eventType: string;
  actor: ActivityActor;
  payload: Record<string, unknown>;
  projectKey?: string;
  createdAt: number;
}

export interface ActivityEvent {
  activityId: string;
  occurredAt: string;
  eventType: string;
  actor: ActivityActor;
  summary: string;
  projectKey?: string;
}

export interface ActivityTimelinePage {
  events: ActivityEvent[];
  cursor: string;
  isDone: boolean;
}

export type ActivityTimelineResult =
  ({ status: "available" } & ActivityTimelinePage) | { status: "unavailable"; reason: string };

export interface ActivityEventReader {
  listActivityPage(input: {
    cursor: string | null;
    limit: number;
  }): Promise<{ events: RawActivityEvent[]; continueCursor: string; isDone: boolean }>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Every summary is built only from a fixed, known-safe subset of an event's
 * payload — identifiers, counts, and booleans that were already recorded for
 * an unrelated authoritative purpose (tool-action / memory-change-set state
 * tracking), never the raw payload verbatim. An event type not in this table
 * (including any future one) falls through to the type-only fallback below,
 * so a new emitter can never leak an unreviewed field into the timeline by
 * accident.
 */
const SUMMARISERS: Record<string, (payload: Record<string, unknown>) => string> = {
  "tool.action.proposed": (p) =>
    `Tool action ${text(p.actionId) ?? "unknown"} proposed (${text(p.tool) ?? "?"}.${text(p.operation) ?? "?"}).`,
  "tool.action.approved": (p) => `Tool action ${text(p.actionId) ?? "unknown"} approved.`,
  "tool.action.rejected": (p) =>
    `Tool action ${text(p.actionId) ?? "unknown"} rejected${text(p.reason) ? `: ${text(p.reason)}.` : "."}`,
  "tool.action.execution-claimed": (p) =>
    `Tool action ${text(p.actionId) ?? "unknown"} execution claimed.`,
  "memory.change_set.proposed": (p) => {
    const count = typeof p.recordCount === "number" ? p.recordCount : undefined;
    return `Memory change set ${text(p.changeSetId) ?? "unknown"} proposed${count === undefined ? "." : ` (${count} record${count === 1 ? "" : "s"}).`}`;
  },
  "memory.change_set.approved": (p) =>
    `Memory change set ${text(p.changeSetId) ?? "unknown"} approved.`,
  "memory.change_set.rejected": (p) =>
    `Memory change set ${text(p.changeSetId) ?? "unknown"} rejected${text(p.reason) ? `: ${text(p.reason)}.` : "."}`,
  "memory.change_set.applied": (p) =>
    `Memory change set ${text(p.changeSetId) ?? "unknown"} applied.`,
};

function summarise(eventType: string, payload: Record<string, unknown>): string {
  const summariser = SUMMARISERS[eventType];
  return summariser ? summariser(payload) : `${eventType} event.`;
}

function toActivityEvent(raw: RawActivityEvent): ActivityEvent {
  return {
    activityId: raw.activityId,
    occurredAt: new Date(raw.createdAt).toISOString(),
    eventType: raw.eventType,
    actor: raw.actor,
    summary: summarise(raw.eventType, raw.payload),
    ...(raw.projectKey === undefined ? {} : { projectKey: raw.projectKey }),
  };
}

/**
 * Reads one bounded page of the durable, owner-wide activity timeline. A
 * read failure is reported as `{status: "unavailable", reason}` rather than
 * thrown or silently turned into an empty page — an empty page must always
 * mean "no activity", never "the read failed".
 */
export async function readActivityTimelinePage(input: {
  reader: ActivityEventReader;
  cursor: string | null;
  limit: number;
}): Promise<ActivityTimelineResult> {
  try {
    const page = await input.reader.listActivityPage({
      cursor: input.cursor,
      limit: input.limit,
    });
    return {
      status: "available",
      events: page.events.map(toActivityEvent),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "Unknown read failure.";
    return { status: "unavailable", reason };
  }
}
