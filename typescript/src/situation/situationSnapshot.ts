/**
 * NOLAN Situation Snapshot (#837): a read-only, schema-validated summary of
 * what is going on right now, composed from Jarvis's existing read models.
 *
 * Every field says where it came from (`source`), when it was observed
 * (`observedAt`) and how fresh it is:
 *   - `live`: read from the authoritative source while composing this snapshot;
 *   - `cached`: an earlier observation still within its stated age limit;
 *   - `stale`: an earlier observation past its age limit (value kept, flagged);
 *   - `unknown`: not observed. Such a field carries no value, only a reason.
 *
 * Read-only by construction: it calls list/read methods only and never
 * stages, approves, rejects or executes a ToolAction, and never actuates a
 * device. Calendar, presence and device state have no commissioned source
 * yet, so they are reported as unknown, never inferred (for example from
 * network activity). Cached data is never reported as live.
 */

import { z } from "zod";

import type { ToolActionService } from "../actions/toolActions.js";
import { composeDailyBrief } from "../briefs/brief.js";
import type { SystemStatus } from "../http/contracts.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import { publicReminder, publicTask } from "../persistence/publicRecords.js";
import type { ProjectStore } from "../projects/project.js";
import type { RuntimeReconciliationHealth } from "../reconciliation/runtimeReconciliationHost.js";
import { resolveReminderTimezone } from "../reminders/due.js";

const TITLE_LIMIT = 5;
/** Used when the reconciliation host states no freshness window of its own. */
const DEFAULT_RECONCILIATION_MAX_AGE_MS = 15 * 60_000;

export const SITUATION_FRESHNESS = ["live", "cached", "stale", "unknown"] as const;
export type SituationFreshness = (typeof SITUATION_FRESHNESS)[number];

/**
 * One observed field. `available` always carries a value and an observation
 * time; `unavailable` (a source failed or is not connected) and `unknown`
 * (nothing observes it) never carry a value and are never fresh.
 */
function fieldSchema<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      status: z.enum(["available", "unavailable", "unknown"]),
      freshness: z.enum(SITUATION_FRESHNESS),
      source: z.string().min(1),
      observedAt: z.string().datetime().nullable(),
      value: value.optional(),
      reason: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((field, context) => {
      if (field.status === "available") {
        if (field.value === undefined) {
          context.addIssue({ code: "custom", message: "An available field carries a value." });
        }
        if (field.observedAt === null || field.freshness === "unknown") {
          context.addIssue({
            code: "custom",
            message: "An available field has an observation time and a known freshness.",
          });
        }
      } else {
        if (field.value !== undefined) {
          context.addIssue({ code: "custom", message: "An unobserved field carries no value." });
        }
        if (field.freshness !== "unknown" || field.observedAt !== null) {
          context.addIssue({ code: "custom", message: "An unobserved field is never fresh." });
        }
        if (!field.reason) {
          context.addIssue({ code: "custom", message: "An unobserved field says why." });
        }
      }
    });
}

const titles = z.array(z.string()).max(TITLE_LIMIT);
const never = z.never();

export const situationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    timezone: z.string().nullable(),
    fields: z
      .object({
        localTime: fieldSchema(
          z.object({ localDate: z.string(), localTime: z.string(), weekday: z.string() }).strict(),
        ),
        systemHealth: fieldSchema(
          z
            .object({
              overall: z.enum(["ok", "degraded", "unavailable"]),
              persistence: z.string(),
              provider: z.string(),
              version: z.string(),
            })
            .strict(),
        ),
        nolanBrain: fieldSchema(
          z
            .object({
              configured: z.boolean(),
              provider: z.string().nullable(),
              model: z.string().nullable(),
              liveProbe: z.literal(false),
            })
            .strict(),
        ),
        reconciliation: fieldSchema(
          z
            .object({
              state: z.string(),
              lastCycleOutcome: z.enum(["success", "degraded", "failed"]).nullable(),
              consecutiveFailureCount: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        openTasks: fieldSchema(
          z.object({ count: z.number().int().nonnegative(), titles }).strict(),
        ),
        reminders: fieldSchema(
          z
            .object({
              dueCount: z.number().int().nonnegative(),
              due: titles,
              upcomingCount: z.number().int().nonnegative(),
              upcoming: titles,
            })
            .strict(),
        ),
        jobsToday: fieldSchema(
          z.object({ count: z.number().int().nonnegative(), titles }).strict(),
        ),
        pendingApprovals: fieldSchema(
          z.object({ count: z.number().int().nonnegative(), capped: z.boolean() }).strict(),
        ),
        calendar: fieldSchema(never),
        presence: fieldSchema(never),
        devices: fieldSchema(never),
      })
      .strict(),
  })
  .strict();

export type SituationSnapshot = z.infer<typeof situationSnapshotSchema>;
type Fields = SituationSnapshot["fields"];
type Field<K extends keyof Fields> = Fields[K];

export type SituationSources = Readonly<{
  now: () => number;
  /** The operator timezone (JARVIS_TIMEZONE); invalid values leave time fields unknown. */
  timezone: string | undefined;
  status: Pick<{ inspect(): Promise<SystemStatus> }, "inspect"> | null;
  tasks: Pick<PersistenceProvider, "listTasks"> | null;
  reminders: Pick<PersistenceProvider, "listReminders"> | null;
  projects: Pick<ProjectStore, "list"> | null;
  approvals: Pick<ToolActionService, "countProposed"> | null;
  reconciliation: (() => RuntimeReconciliationHealth) | null;
}>;

function unobserved(
  status: "unavailable" | "unknown",
  source: string,
  reason: string,
): {
  status: "unavailable" | "unknown";
  freshness: "unknown";
  source: string;
  observedAt: null;
  reason: string;
} {
  return { status, freshness: "unknown", source, observedAt: null, reason };
}

function live<T>(source: string, observedAt: number, value: T) {
  return {
    status: "available" as const,
    freshness: "live" as const,
    source,
    observedAt: new Date(observedAt).toISOString(),
    value,
  };
}

/** Read one source; a missing source or a failed read becomes `unavailable`. */
async function readLive<R, T>(
  source: string,
  reader: (() => Promise<R>) | null,
  missing: string,
  failed: string,
  now: () => number,
  shape: (result: R) => T,
) {
  if (!reader) return unobserved("unavailable", source, missing);
  try {
    const result = await reader();
    return live(source, now(), shape(result));
  } catch {
    return unobserved("unavailable", source, failed);
  }
}

function localTimeField(now: number, timezone: string | null): Field<"localTime"> {
  if (!timezone) {
    return unobserved("unknown", "clock", "The operator timezone (JARVIS_TIMEZONE) is invalid.");
  }
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return live("clock", now, {
    localDate: `${part("year")}-${part("month")}-${part("day")}`,
    localTime: `${part("hour")}:${part("minute")}`,
    weekday: part("weekday"),
  });
}

function reconciliationField(
  read: (() => RuntimeReconciliationHealth) | null,
  now: number,
): Field<"reconciliation"> {
  const source = "runtime reconciliation host";
  if (!read) return unobserved("unknown", source, "No reconciliation host is attached.");
  let health: RuntimeReconciliationHealth;
  try {
    health = read();
  } catch {
    return unobserved("unavailable", source, "Reconciliation health could not be read.");
  }
  if (!health.enabled) {
    return unobserved(
      "unknown",
      source,
      "Background reconciliation is disabled in this deployment.",
    );
  }
  const at = health.lastSuccessfulCycleAt ? Date.parse(health.lastSuccessfulCycleAt) : Number.NaN;
  if (!Number.isFinite(at)) {
    return unobserved("unknown", source, "No successful reconciliation cycle has been recorded.");
  }
  const maxAge = health.freshnessMs ?? DEFAULT_RECONCILIATION_MAX_AGE_MS;
  // An earlier observation: cached while inside its window, stale after. Never live.
  return {
    status: "available",
    freshness: now - at <= maxAge ? "cached" : "stale",
    source,
    observedAt: new Date(at).toISOString(),
    value: {
      state: health.state,
      lastCycleOutcome: health.lastCycleOutcome ?? null,
      consecutiveFailureCount: health.consecutiveFailureCount ?? 0,
    },
  };
}

const firstTitles = (items: readonly { title: string }[]) =>
  items.slice(0, TITLE_LIMIT).map((item) => item.title);

export async function composeSituationSnapshot(
  input: SituationSources,
): Promise<SituationSnapshot> {
  const now = input.now();
  let timezone: string | null;
  try {
    timezone = resolveReminderTimezone(input.timezone);
  } catch {
    timezone = null;
  }
  const brief = (parts: Partial<Parameters<typeof composeDailyBrief>[0]>) =>
    composeDailyBrief({
      now,
      timezone: timezone as string,
      tasks: [],
      reminders: [],
      projects: [],
      quotes: [],
      assets: [],
      enquiries: [],
      invoices: [],
      errands: [],
      ...parts,
    });
  const noTimezone = (source: string) =>
    unobserved("unknown", source, "The operator timezone (JARVIS_TIMEZONE) is invalid.");

  const [statusField, openTasks, reminders, jobsToday, pendingApprovals] = await Promise.all([
    readLive(
      "system status",
      input.status ? () => input.status!.inspect() : null,
      "No system status service is attached.",
      "System status could not be read.",
      input.now,
      (status) => status,
    ),
    readLive(
      "task records",
      input.tasks ? () => input.tasks!.listTasks() : null,
      "No task source is connected.",
      "Task records could not be read.",
      input.now,
      (rows) => {
        const open = rows.map(publicTask).filter((task) => !task.completed);
        return { count: open.length, titles: firstTitles(open) };
      },
    ),
    timezone
      ? readLive(
          "reminder records",
          input.reminders ? () => input.reminders!.listReminders() : null,
          "No reminder source is connected.",
          "Reminder records could not be read.",
          input.now,
          (rows) => {
            const slice = brief({ reminders: rows.map(publicReminder) }).reminders;
            return {
              dueCount: slice.dueCount,
              due: firstTitles(slice.due),
              upcomingCount: slice.upcomingCount,
              upcoming: firstTitles(slice.upcoming),
            };
          },
        )
      : noTimezone("reminder records"),
    timezone
      ? readLive(
          "project schedule",
          input.projects ? () => input.projects!.list() : null,
          "No project source is connected.",
          "Project records could not be read.",
          input.now,
          (rows) => {
            const scheduled = brief({ projects: rows }).scheduled;
            return { count: scheduled.todayCount, titles: firstTitles(scheduled.today) };
          },
        )
      : noTimezone("project schedule"),
    readLive(
      "governed tool actions",
      input.approvals?.countProposed ? () => input.approvals!.countProposed!({ limit: 100 }) : null,
      "Pending approvals need the configured Convex tool-action service.",
      "Pending approvals could not be read.",
      input.now,
      (result) => ({ count: result.count, capped: result.capped }),
    ),
  ]);

  const systemHealth: Field<"systemHealth"> =
    statusField.status === "available"
      ? {
          ...statusField,
          value: {
            overall: statusField.value.status,
            persistence: statusField.value.provider.reachability,
            provider: statusField.value.provider.name,
            version: statusField.value.version,
          },
        }
      : statusField;
  const nolanBrain: Field<"nolanBrain"> =
    statusField.status === "available"
      ? {
          ...statusField,
          source: "voice conversation configuration",
          value: {
            configured: statusField.value.voiceConversation.status === "configured",
            provider: statusField.value.voiceConversation.provider,
            model: statusField.value.voiceConversation.model,
            // Configuration only: no live call to the model provider is made.
            liveProbe: false,
          },
        }
      : { ...statusField, source: "voice conversation configuration" };

  return situationSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    timezone,
    fields: {
      localTime: localTimeField(now, timezone),
      systemHealth,
      nolanBrain,
      reconciliation: reconciliationField(input.reconciliation, now),
      openTasks,
      reminders,
      jobsToday,
      pendingApprovals,
      calendar: unobserved(
        "unknown",
        "none",
        "No calendar source is connected. Appointments are not invented.",
      ),
      presence: unobserved(
        "unknown",
        "none",
        "Presence is not observed; it is never inferred from network or device activity.",
      ),
      devices: unobserved(
        "unknown",
        "none",
        "No device adapter is commissioned (device-binding registry #836 is not implemented); device state is never inferred.",
      ),
    },
  });
}
