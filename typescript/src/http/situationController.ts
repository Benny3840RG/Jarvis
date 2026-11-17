import { Controller, Get, Header, Inject, Optional } from "@nestjs/common";

import type { ToolActionService } from "../actions/toolActions.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import type { ProjectStore } from "../projects/project.js";
import type { RuntimeReconciliationHealth } from "../reconciliation/runtimeReconciliationHost.js";
import {
  composeSituationSnapshot,
  type SituationSnapshot,
} from "../situation/situationSnapshot.js";
import type { HttpAppConfig } from "./config.js";
import { SystemStatusService } from "./systemStatusService.js";
import {
  HTTP_APP_CONFIG,
  HTTP_PERSISTENCE,
  HTTP_PROJECT_STORE,
  HTTP_RECONCILIATION_HEALTH,
  HTTP_TOOL_ACTIONS,
} from "./tokens.js";

/**
 * NOLAN situation snapshot (#837). Requires the service token like the other
 * read routes. Read-only: it composes existing read models and never stages,
 * approves or executes a ToolAction or actuates a device.
 */
@Controller("api/v1/situation")
export class SituationController {
  constructor(
    @Inject(SystemStatusService) private readonly status: SystemStatusService,
    @Inject(HTTP_PERSISTENCE) private readonly persistence: PersistenceProvider,
    @Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig,
    @Inject(HTTP_PROJECT_STORE) private readonly projects: ProjectStore,
    @Inject(HTTP_RECONCILIATION_HEALTH)
    private readonly reconciliationHealth: () => RuntimeReconciliationHealth,
    @Optional()
    @Inject(HTTP_TOOL_ACTIONS)
    private readonly toolActions?: ToolActionService | null,
  ) {}

  @Get()
  @Header("Cache-Control", "no-store")
  snapshot(): Promise<SituationSnapshot> {
    return composeSituationSnapshot({
      now: Date.now,
      timezone: this.config.timezone,
      status: this.status,
      tasks: this.persistence,
      reminders: this.persistence,
      projects: this.projects,
      approvals: this.toolActions ?? null,
      reconciliation: this.reconciliationHealth,
    });
  }
}
