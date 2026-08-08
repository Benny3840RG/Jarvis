import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import type { ToolExecutionService } from "../actions/toolExecution.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import type { PersistenceProviderName } from "../persistence/providerSelection.js";
import type { RuntimeReconciliationHealth } from "../reconciliation/runtimeReconciliationHost.js";
import { resolveReminderTimezone } from "../reminders/due.js";
import { ReliabilityController } from "../reliability/reliabilityController.js";
import { assessReconciliationHealth } from "../reliability/reliabilityHealth.js";
import type { HttpAppConfig } from "./config.js";
import type { IntegrationStatus, LayersStatus, SystemStatus } from "./contracts.js";
import { JarvisProblem } from "./problemDetails.js";
import {
  HTTP_APP_CONFIG,
  HTTP_PERSISTENCE,
  HTTP_PROVIDER_NAME,
  HTTP_RECONCILIATION_HEALTH,
  HTTP_TOOL_EXECUTION,
} from "./tokens.js";

const LAYERS: LayersStatus = {
  runtime: {
    status: "partial",
    reason:
      "Conversation, orchestration, and memory prototypes exist; the maintained runtime integration core is present, while durable event delivery remains pending.",
  },
  domains: {
    status: "partial",
    reason:
      "Business, workshop, and home domain state is versioned and durable through the configured JSON or Convex persistence provider; promotion into the maintained operational surface remains pending.",
  },
  integration: {
    status: "partial",
    reason:
      "The runtime has explicit EventBus, ToolGateway, domain registry, memory linker, tool router, and a Convex-backed metadata event sink at the CLI seam; governed HTTP composition and live commissioning remain pending.",
  },
  orchestration: {
    status: "partial",
    reason:
      "A validated trigger registry, weighted dependency graph, and bounded fail-closed runner exist; durable run state, production composition, and governed workflow evolution remain pending.",
  },
  safety: {
    status: "partial",
    reason:
      "The six immutable safety categories are bound at reasoning and governed tool-execution boundaries; durable category evidence for every lifecycle transition remains pending.",
  },
  adaptive: {
    status: "partial",
    reason:
      "Learning is scaffolded; prediction, consolidation, intent modelling, and stabilisation are pending.",
  },
  autonomy: {
    status: "partial",
    reason:
      "Workflow generation is scaffolded; proposal simulation and safe evolution remain pending.",
  },
  reliability: {
    status: "partial",
    reason:
      "Evidence-backed reliability probes and recovery controls exist at the HTTP status boundary; live provider commissioning and operational alert delivery remain pending.",
  },
};

@Injectable()
export class SystemStatusService {
  private readonly reliability = new ReliabilityController();

  constructor(
    @Inject(HTTP_PERSISTENCE) private readonly persistence: PersistenceProvider,
    @Inject(HTTP_PROVIDER_NAME)
    private readonly providerName: PersistenceProviderName,
    @Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig,
    @Inject(HTTP_RECONCILIATION_HEALTH)
    private readonly reconciliationHealth: () => RuntimeReconciliationHealth,
    @Inject(HTTP_TOOL_EXECUTION)
    private readonly toolExecutionService: ToolExecutionService | null,
  ) {}

  /**
   * Evidence-backed, not inferred from env-var presence: reports whether the
   * `quotes:send` tool is actually registered on the running
   * `ToolExecutionService` — the same conditional registration
   * `toolExecutionFactory.ts` already performs from the real quote-delivery
   * dependency bundle (Convex, quote repository, email provider, delivery
   * repository, PDF artifact repository). No new live call to Outlook is
   * made here.
   */
  private quoteDeliveryIntegrationStatus(): IntegrationStatus {
    if (!this.toolExecutionService) {
      return {
        name: "quote-delivery",
        status: "not-commissioned",
        reason:
          "Tool execution is not configured in this deployment (requires Convex persistence).",
      };
    }
    if (!this.toolExecutionService.isRegistered("quotes", "send")) {
      return {
        name: "quote-delivery",
        status: "not-commissioned",
        reason:
          "The quotes:send tool is not registered — one or more of the quote repository, email provider, delivery repository, or PDF artifact repository is not configured.",
      };
    }
    return { name: "quote-delivery", status: "commissioned" };
  }

  async inspect(): Promise<SystemStatus> {
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
      await this.reliability.run("persistence", async () => {
        await Promise.all([
          this.persistence.loadState(),
          this.persistence.listTasks(),
          this.persistence.listReminders(),
        ]);
      });
    } catch {
      throw new JarvisProblem(
        HttpStatus.SERVICE_UNAVAILABLE,
        "persistence-unavailable",
        "Persistence Unavailable",
        "The configured persistence provider could not be reached or validated.",
      );
    }

    const reconciliation = { ...this.reconciliationHealth() };
    const reconciliationAssessment = assessReconciliationHealth(reconciliation);
    return {
      status: reconciliationAssessment.healthy ? "ok" : "degraded",
      version: this.config.version,
      sourceVersion: this.config.sourceVersion,
      provider: {
        name: this.providerName,
        reachability: "ok",
        authentication: this.providerName === "json" ? "not-required" : "ok",
        schemaCompatibility: "compatible",
        deploymentVersion: this.config.deploymentVersion,
      },
      reconciliation,
      integrations: [this.quoteDeliveryIntegrationStatus()],
      timezone,
      layers: { ...LAYERS, reliability: this.reliability.layerStatus() },
      zState: "disabled",
      checkedAt: new Date().toISOString(),
    };
  }
}
