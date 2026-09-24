import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";

import { DangerZoneRefusal } from "../settings/dangerZone/errors.js";
import type { DangerZoneService } from "../settings/dangerZone/service.js";
import { renderDangerZonePage } from "../settings/dangerZone/page.js";
import { parseDangerZoneActionId, parseDangerZoneActionRequest } from "./dangerZoneRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_DANGER_ZONE } from "./tokens.js";

function toProblem(error: DangerZoneRefusal): JarvisProblem {
  const status =
    error.code === "lock" || error.code === "in-flight"
      ? HttpStatus.CONFLICT
      : HttpStatus.UNPROCESSABLE_ENTITY;
  return new JarvisProblem(
    status,
    `danger-zone-${error.code}`,
    "Danger Zone Refused",
    error.message,
  );
}

@Controller("api/v1/settings/danger-zone")
export class DangerZoneController {
  constructor(@Inject(HTTP_DANGER_ZONE) private readonly dangerZone: DangerZoneService) {}

  @Get()
  async getModel(): Promise<Awaited<ReturnType<DangerZoneService["inspect"]>>> {
    return this.dangerZone.inspect();
  }

  @Get("page")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @Header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  )
  async getPage(): Promise<string> {
    return renderDangerZonePage(await this.dangerZone.inspect());
  }

  @Post("actions/:actionId")
  @HttpCode(HttpStatus.OK)
  async execute(
    @Param("actionId") actionId: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<DangerZoneService["execute"]>>> {
    try {
      return await this.dangerZone.execute(
        parseDangerZoneActionId(actionId),
        parseDangerZoneActionRequest(body),
      );
    } catch (error: unknown) {
      if (error instanceof DangerZoneRefusal) throw toProblem(error);
      throw new JarvisProblem(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "danger-zone-failed",
        "Danger Zone Refused",
        "Danger zone action failed.",
      );
    }
  }
}
