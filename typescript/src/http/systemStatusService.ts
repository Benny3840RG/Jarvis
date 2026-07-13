import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import type { PersistenceProvider } from "../persistence/persistence.js";
import type { PersistenceProviderName } from "../persistence/providerSelection.js";
import { resolveReminderTimezone } from "../reminders/due.js";
import type { HttpAppConfig } from "./config.js";
import type { LayersStatus, SystemStatus } from "./contracts.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_APP_CONFIG, HTTP_PERSISTENCE, HTTP_PROVIDER_NAME } from "./tokens.js";

const LAYERS: LayersStatus = {
  runtime: {
    status: "partial",
    reason:
      "Conversation, orchestration, and memory prototypes exist; EventBus and Tool Gateway remain pending.",
  },
  domains: {
    status: "partial",
    reason: "Business, workshop, and home engines remain non-durable prototypes.",
  },
  integration: {
    status: "inactive",
    reason:
      "The domain registry, safety binder, memory linker, and tool router are not implemented.",
  },
  orchestration: {
    status: "partial",
    reason:
      "A prototype graph exists; production triggers, weights, and evolution boundaries remain pending.",
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
    reason: "Health monitoring, circuit breakers, and recovery management are not implemented.",
  },
};

@Injectable()
export class SystemStatusService {
  constructor(
    @Inject(HTTP_PERSISTENCE) private readonly persistence: PersistenceProvider,
    @Inject(HTTP_PROVIDER_NAME) private readonly providerName: PersistenceProviderName,
    @Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig,
  ) {}

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
      await Promise.all([
        this.persistence.loadState(),
        this.persistence.listTasks(),
        this.persistence.listReminders(),
      ]);
    } catch {
      throw new JarvisProblem(
        HttpStatus.SERVICE_UNAVAILABLE,
        "persistence-unavailable",
        "Persistence Unavailable",
        "The configured persistence provider could not be reached or validated.",
      );
    }

    return {
      status: "ok",
      version: this.config.version,
      sourceVersion: this.config.sourceVersion,
      provider: {
        name: this.providerName,
        reachability: "ok",
        authentication: this.providerName === "json" ? "not-required" : "ok",
        schemaCompatibility: "compatible",
        deploymentVersion: this.config.deploymentVersion,
      },
      timezone,
      layers: LAYERS,
      zState: "disabled",
      checkedAt: new Date().toISOString(),
    };
  }
}
