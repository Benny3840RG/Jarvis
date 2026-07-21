import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";

import type { Upgrade, UpgradeStore } from "../upgrades/upgrade.js";
import { parseCreateUpgrade, parseUpdateUpgrade } from "./upgradeRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_UPGRADE_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-upgrade",
    "Invalid Upgrade",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "upgrade-not-found",
    "Upgrade Not Found",
    "The requested upgrade does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "upgrade-persistence-failed",
    "Upgrade Operation Failed",
    "The configured upgrade store could not complete the operation.",
  );
}

function upgradeResponse(upgrade: Upgrade): { data: Upgrade } {
  return { data: upgrade };
}

@Controller("api/v1/upgrades")
export class UpgradeController {
  constructor(@Inject(HTTP_UPGRADE_STORE) private readonly upgrades: UpgradeStore) {}

  @Get()
  async list() {
    try {
      const data = await this.upgrades.list();
      return { data, count: data.length };
    } catch {
      throw operationFailed();
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const input = (() => {
      try {
        return parseCreateUpgrade(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The upgrade request is invalid.");
      }
    })();
    try {
      return upgradeResponse(await this.upgrades.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|must not|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":upgradeId")
  async get(@Param("upgradeId") upgradeId: string) {
    let upgrade: Upgrade | null;
    try {
      upgrade = await this.upgrades.get(upgradeId);
    } catch {
      throw operationFailed();
    }
    if (!upgrade) throw notFound();
    return upgradeResponse(upgrade);
  }

  @Patch(":upgradeId")
  async update(@Param("upgradeId") upgradeId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateUpgrade(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The upgrade update is invalid.");
      }
    })();
    let upgrade: Upgrade | null;
    try {
      upgrade = await this.upgrades.update(upgradeId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|must not|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!upgrade) throw notFound();
    return upgradeResponse(upgrade);
  }

  @Delete(":upgradeId")
  async remove(@Param("upgradeId") upgradeId: string) {
    let upgrade: Upgrade | null;
    try {
      upgrade = await this.upgrades.remove(upgradeId);
    } catch {
      throw operationFailed();
    }
    if (!upgrade) throw notFound();
    return upgradeResponse(upgrade);
  }
}
