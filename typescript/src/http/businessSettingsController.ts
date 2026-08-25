import { Body, Controller, Get, HttpStatus, Inject, Patch } from "@nestjs/common";

import type {
  BusinessSettings,
  BusinessSettingsStore,
} from "../businessSettings/businessSettings.js";
import { parseUpdateBusinessSettings } from "./businessSettingsRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_BUSINESS_SETTINGS_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-business-settings",
    "Invalid Business Settings",
    detail,
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "business-settings-persistence-failed",
    "Business Settings Operation Failed",
    "The configured business settings store could not complete the operation.",
  );
}

function settingsResponse(settings: BusinessSettings): { data: BusinessSettings } {
  return { data: settings };
}

@Controller("api/v1/business-settings")
export class BusinessSettingsController {
  constructor(
    @Inject(HTTP_BUSINESS_SETTINGS_STORE)
    private readonly settings: BusinessSettingsStore,
  ) {}

  @Get()
  async get() {
    try {
      return settingsResponse(await this.settings.get());
    } catch {
      throw operationFailed();
    }
  }

  @Patch()
  async update(@Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateBusinessSettings(body);
      } catch (error: unknown) {
        throw invalid(
          error instanceof Error ? error.message : "The business settings update is invalid.",
        );
      }
    })();
    try {
      return settingsResponse(await this.settings.update(input));
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        /empty|must be|must not|requires|credentials/.test(error.message)
      )
        throw invalid(error.message);
      throw operationFailed();
    }
  }
}
