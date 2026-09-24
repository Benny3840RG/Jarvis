import { Controller, Get, Inject } from "@nestjs/common";

import { inspectReminderTimezone, type OperatorGeneralSettings } from "../reminders/due.js";
import type { HttpAppConfig } from "./config.js";
import { HTTP_APP_CONFIG } from "./tokens.js";

/**
 * Read-only Settings → General timezone status. Display preferences stay in
 * the console. This route does not write JARVIS_TIMEZONE or durable preferences.
 */
@Controller("api/v1/settings/general")
export class GeneralSettingsController {
  constructor(@Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig) {}

  @Get()
  get(): OperatorGeneralSettings {
    return { timezone: inspectReminderTimezone(this.config.timezone) };
  }
}
