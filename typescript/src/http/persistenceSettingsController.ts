import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";

import { PersistenceSettingsService } from "../settings/persistenceSettingsService.js";
import { parsePersistenceAction } from "../settings/persistenceSettings.js";
import { JarvisProblem } from "./problemDetails.js";

@Controller("api/v1/settings/persistence")
export class PersistenceSettingsController {
  constructor(
    @Inject(PersistenceSettingsService)
    private readonly settings: PersistenceSettingsService,
  ) {}

  @Get()
  read() {
    return this.settings.read();
  }

  @Post("actions")
  @HttpCode(HttpStatus.OK)
  async act(@Body() body: unknown) {
    const parsed = parsePersistenceAction(body);
    if (!parsed.ok) {
      throw new JarvisProblem(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "invalid-persistence-action",
        "Invalid Persistence Action",
        parsed.detail,
      );
    }
    return this.settings.run(parsed.action);
  }
}
