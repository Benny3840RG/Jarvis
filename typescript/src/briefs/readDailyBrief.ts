/**
 * Read the authoritative daily brief from the persistence provider and business
 * stores. This is the single source of truth for composing a {@link DailyBrief}
 * from live stores; the HUD snapshot and the voice query provider both use it so
 * they can never drift into two different "today" projections.
 */

import type { AssetStore } from "../assets/asset.js";
import type { EnquiryStore } from "../enquiries/enquiry.js";
import type { ErrandStore } from "../errands/errand.js";
import type { InvoiceStore } from "../invoices/invoice.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import type { ProjectStore } from "../projects/project.js";
import type { QuoteStore } from "../quotes/quote.js";
import { resolveReminderTimezone } from "../reminders/due.js";
import { composeDailyBrief, type DailyBrief } from "./brief.js";

export type DailyBriefSources = {
  persistence: PersistenceProvider;
  projects: ProjectStore;
  quotes: QuoteStore;
  assets: AssetStore;
  enquiries: EnquiryStore;
  invoices: InvoiceStore;
  errands: ErrandStore;
  /** Raw configured timezone; resolved to a valid IANA zone here. */
  timezone: string | undefined;
  /** Instant the brief is composed for. Defaults to now. */
  now?: number;
};

export async function readDailyBrief(sources: DailyBriefSources): Promise<DailyBrief> {
  const timezone = resolveReminderTimezone(sources.timezone);
  const now = sources.now ?? Date.now();
  const [tasks, reminders, projects, quotes, assets, enquiries, invoices, errands] =
    await Promise.all([
      sources.persistence.listTasks(),
      sources.persistence.listReminders(),
      sources.projects.list(),
      sources.quotes.list(),
      sources.assets.list(),
      sources.enquiries.list({ status: "open" }),
      sources.invoices.list(),
      sources.errands.list(),
    ]);
  return composeDailyBrief({
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
}
