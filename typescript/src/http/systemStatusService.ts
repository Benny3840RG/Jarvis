import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import type { ToolExecutionService } from "../actions/toolExecution.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import type { PersistenceProviderName } from "../persistence/providerSelection.js";
import type { RuntimeReconciliationHealth } from "../reconciliation/runtimeReconciliationHost.js";
import { resolveReminderTimezone } from "../reminders/due.js";
import { ReliabilityController } from "../reliability/reliabilityController.js";
import { assessReconciliationHealth } from "../reliability/reliabilityHealth.js";
import { resolveTotalityReasoningStatus } from "../totality/totalityFactory.js";
import type { HttpAppConfig } from "./config.js";
import type { IntegrationStatus, LayersStatus, SystemStatus } from "./contracts.js";
import { integrationStatusFromStage } from "./contracts.js";
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
    // Disambiguated: the prototype *engines* in `src/domains/` are non-durable,
    // but the trade-business record stores (clients, properties, projects,
    // quotes, invoices, enquiries, errands) are durable. Reporting only the
    // first half read as "business data is not durable", which is false.
    reason:
      "The trade-business record stores (clients, properties, projects, quotes, invoices, enquiries, errands) are durable; the separate business, workshop, and home reasoning engines in src/domains/ remain non-durable prototypes whose generated records are synthetic and never persisted.",
  },
  integration: {
    status: "partial",
    reason:
      "The runtime has explicit EventBus, ToolGateway, domain registry, memory linker, tool router, and a Convex-backed metadata event sink at the CLI seam; governed HTTP composition and live commissioning remain pending.",
  },
  orchestration: {
    status: "partial",
    // Durable run state is no longer pending: `convex/orchestrationState.ts`
    // persists runs and steps with worker-bound leases and fencing tokens, and
    // `src/orchestration/convexStateBoundary.ts` composes it. What is still
    // pending is recorded commissioning evidence for this composition.
    // Static status prose cannot determine whether a live drill has occurred.
    reason:
      "A validated trigger registry, weighted dependency graph, bounded fail-closed runner, and durable Convex-backed run/step state with worker-bound leases are implemented and covered by offline tests; the Development Actions bridge has durable admission and completion scheduling, while this status reader does not inspect live commissioning evidence; governed workflow evolution remains pending.",
  },
  safety: {
    status: "partial",
    reason:
      "The prototype envelope exists; all five immutable safety categories are not yet bound to every transition.",
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
    status: "inactive",
    reason: "No reliability probe evidence has been collected.",
  },
};

@Injectable()
export class SystemStatusService {
  private readonly reliability = new ReliabilityController();

  constructor(
    @Inject(HTTP_PERSISTENCE) private readonly persistence: PersistenceProvider,
    @Inject(HTTP_PROVIDER_NAME) private readonly providerName: PersistenceProviderName,
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
   *
   * Registration is evidence of `configured` and nothing stronger. It proves the
   * dependency bundle is wired; it does not prove Outlook has ever been reached,
   * and it carries no operator approval. `commissioned` requires a recorded
   * result from exercising the real provider, and `production-approved` requires
   * a human decision — neither has a wired evidence source yet, so neither is
   * reachable here. Reporting `configured` is the honest ceiling.
   */
  private quoteDeliveryIntegrationStatus(): IntegrationStatus {
    if (!this.toolExecutionService) {
      return {
        name: "quote-delivery",
        stage: "implemented",
        status: integrationStatusFromStage("implemented"),
        reason:
          "Tool execution is not configured in this deployment (requires Convex persistence).",
      };
    }
    if (!this.toolExecutionService.isRegistered("quotes", "send")) {
      return {
        name: "quote-delivery",
        stage: "implemented",
        status: integrationStatusFromStage("implemented"),
        reason:
          "The quotes:send tool is not registered — one or more of the quote repository, email provider, delivery repository, or PDF artifact repository is not configured.",
      };
    }
    return {
      name: "quote-delivery",
      stage: "configured",
      status: integrationStatusFromStage("configured"),
      reason:
        "The quotes:send dependency bundle is registered, so this deployment is configured. No commissioning or production-approval evidence reader is wired into this status check; live delivery and production approval are unknown here.",
    };
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
      reasoning: resolveTotalityReasoningStatus(this.providerName),
      timezone,
      layers: { ...LAYERS, reliability: this.reliability.layerStatus() },
      zState: "disabled",
      checkedAt: new Date().toISOString(),
    };
  }
}
