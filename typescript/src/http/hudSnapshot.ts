import { composeDailyBrief } from "../briefs/brief.js";
import { readLiveWorkPipeline, type DevelopmentLiveWorkSource } from "../development/liveWork.js";
import type { DashboardSnapshot } from "../mcp/jarvisApiClient.js";
import {
  readActivityTimelinePage,
  type ActivityEventReader,
} from "../operations/activityTimeline.js";
import { buildOperationsInbox } from "../operations/operationsInbox.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import type { AssetStore } from "../assets/asset.js";
import type { EnquiryStore } from "../enquiries/enquiry.js";
import type { ErrandStore } from "../errands/errand.js";
import type { InvoiceStore } from "../invoices/invoice.js";
import type { ProjectStore } from "../projects/project.js";
import type { QuoteStore } from "../quotes/quote.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import { resolveReminderTimezone } from "../reminders/due.js";
import type { CredentialsRuntime } from "../settings/credentialsStatus.js";
import type { HttpAppConfig } from "./config.js";
import type { SystemStatusService } from "./systemStatusService.js";

const ACTIVITY_UNAVAILABLE =
  "The operations activity timeline requires the configured Convex persistence provider.";
const LIVE_WORK_UNAVAILABLE = "Development Live Work requires configured Convex persistence.";

export type HudSnapshotSources = {
  status: SystemStatusService;
  persistence: PersistenceProvider;
  config: HttpAppConfig;
  projects: ProjectStore;
  quotes: QuoteStore;
  assets: AssetStore;
  enquiries: EnquiryStore;
  invoices: InvoiceStore;
  errands: ErrandStore;
  quoteRepository: QuoteRepository | null;
  activity: ActivityEventReader | null;
  liveWork: DevelopmentLiveWorkSource | null;
  credentials: CredentialsRuntime;
};

/**
 * In-process read of the operator dashboard. Fingerprints only: the credentials
 * runtime's public status is copied, never the service token or digests.
 * A failed inbox read is `null`. A missing activity or live-work source is the
 * same unavailable body those HTTP routes already return.
 */
export async function readHudSnapshot(input: HudSnapshotSources): Promise<DashboardSnapshot> {
  const timezone = resolveReminderTimezone(input.config.timezone);
  const now = Date.now();
  const [tasks, reminders, projects, quotes, assets, enquiries, invoices, errands] =
    await Promise.all([
      input.persistence.listTasks(),
      input.persistence.listReminders(),
      input.projects.list(),
      input.quotes.list(),
      input.assets.list(),
      input.enquiries.list({ status: "open" }),
      input.invoices.list(),
      input.errands.list(),
    ]);
  const brief = composeDailyBrief({
    now,
    timezone,
    tasks,
    reminders,
    projects,
    quotes,
    assets,
    enquiries,
    invoices,
    errands,
  });
  let quoteRegister: DashboardSnapshot["quoteRegister"];
  if (!input.quoteRepository) {
    quoteRegister = { status: "unavailable", quotes: [] };
  } else {
    try {
      quoteRegister = { status: "ready", quotes: await input.quoteRepository.listQuotes({}) };
    } catch {
      quoteRegister = { status: "unavailable", quotes: [] };
    }
  }
  let inbox: DashboardSnapshot["inbox"];
  try {
    inbox = await buildOperationsInbox({
      now,
      listReminders: () => input.persistence.listReminders(),
      listAssets: () => input.assets.list(),
    });
  } catch {
    inbox = null;
  }
  const activity = input.activity
    ? await readActivityTimelinePage({ reader: input.activity, cursor: null, limit: 5 })
    : { status: "unavailable" as const, reason: ACTIVITY_UNAVAILABLE };
  const liveWork = input.liveWork
    ? await readLiveWorkPipeline({ source: input.liveWork })
    : { status: "unavailable" as const, reason: LIVE_WORK_UNAVAILABLE };
  return {
    status: await input.status.inspect(),
    tasks,
    reminders,
    brief,
    quoteRegister,
    inbox,
    activity,
    liveWork,
    credentials: input.credentials.status,
    counts: {
      activeTasks: tasks.filter((task) => !task.completed).length,
      completedTasks: tasks.filter((task) => task.completed).length,
      reminders: reminders.length,
    },
  };
}
