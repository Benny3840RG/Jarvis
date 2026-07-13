import { Controller, Get, Inject } from "@nestjs/common";

import type { HttpAppConfig } from "./config.js";
import {
  IMPLEMENTED_CAPABILITIES,
  type HealthResponse,
  type HelpResponse,
  type SystemStatus,
} from "./contracts.js";
import { PublicRoute } from "./publicRoute.js";
import { SystemStatusService } from "./systemStatusService.js";
import { HTTP_APP_CONFIG } from "./tokens.js";

@Controller()
export class HealthController {
  constructor(@Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig) {}

  @PublicRoute()
  @Get("healthz")
  getHealth(): HealthResponse {
    return {
      status: "ok",
      service: "jarvis",
      version: this.config.version,
      time: new Date().toISOString(),
    };
  }
}

@Controller("api/v1")
export class OperatorSystemController {
  constructor(@Inject(SystemStatusService) private readonly statusService: SystemStatusService) {}

  @Get("help")
  getHelp(): HelpResponse {
    return {
      apiVersion: "v1",
      capabilities: IMPLEMENTED_CAPABILITIES.map((capability) => ({ ...capability })),
    };
  }

  @Get("status")
  getStatus(): Promise<SystemStatus> {
    return this.statusService.inspect();
  }
}
