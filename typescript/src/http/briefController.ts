import { Controller, Get, HttpStatus, Inject } from "@nestjs/common";

import { composeDailyBrief, type DailyBrief } from "../briefs/brief.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import { resolveReminderTimezone } from "../reminders/due.js";
import type { ProjectStore } from "../projects/project.js";
import type { QuoteStore } from "../quotes/quote.js";
import type { AssetStore } from "../assets/asset.js";
import type { HttpAppConfig } from "./config.js";
import { JarvisProblem } from "./problemDetails.js";
import {
  HTTP_APP_CONFIG,
  HTTP_PERSISTENCE,
  HTTP_PROJECT_STORE,
  HTTP_QUOTE_STORE,
  HTTP_ASSET_STORE,
} from "./tokens.js";

function briefUnavailable(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "brief-unavailable",
    "Brief Unavailable",
    "One of the stores backing the daily brief could not be read.",
  );
}

/**
 * Read-only daily digest composed from the authoritative stores. The brief has
 * no storage of its own: every number is derived on request, so it can never
 * drift from the tasks, reminders, projects, and quotes it summarises.
 */
@Controller("api/v1/brief")
export class BriefController {
  constructor(
    @Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig,
    @Inject(HTTP_PERSISTENCE) private readonly persistence: PersistenceProvider,
    @Inject(HTTP_PROJECT_STORE) private readonly projects: ProjectStore,
    @Inject(HTTP_QUOTE_STORE) private readonly quotes: QuoteStore,
    @Inject(HTTP_ASSET_STORE) private readonly assets: AssetStore,
  ) {}

  @Get()
  async get(): Promise<{ data: DailyBrief }> {
    // Same resolution (and failure mode) as the status endpoint.
    let timezone: string;
    try {
      timezone = resolveReminderTimezone(this.config.timezone);
    } catch {
      throw new JarvisProblem(
        HttpStatus.SERVICE_UNAVAILABLE,
        "timezone-unavailable",
        "Timezone Configuration Unavailable",
        "Jarvis timezone configuration is invalid.",
      );
    }
    try {
      const [tasks, reminders, projects, quotes, assets] = await Promise.all([
        this.persistence.listTasks(),
        this.persistence.listReminders(),
        this.projects.list(),
        this.quotes.list(),
        this.assets.list(),
      ]);
      return {
        data: composeDailyBrief({
          now: Date.now(),
          timezone,
          tasks,
          reminders,
          projects,
          quotes,
          assets,
        }),
      };
    } catch {
      throw briefUnavailable();
    }
  }
}
