import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import type { ToolActionService } from "../actions/toolActions.js";
import type { ToolExecutionService } from "../actions/toolExecution.js";
import type { ClientStore } from "../clients/client.js";
import type { ProjectStore } from "../projects/project.js";
import type { QuoteStore } from "../quotes/quote.js";
import type { QuoteDeliveryRepository } from "../quotes/quoteDeliveryRepository.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import type { ErrandStore } from "../errands/errand.js";
import type { BuildStore } from "../builds/build.js";
import type { BuildLogStore } from "../buildLog/buildLogEntry.js";
import type { UpgradeStore } from "../upgrades/upgrade.js";
import type { AssetStore } from "../assets/asset.js";
import type { PreferenceStore } from "../preferences/preference.js";
import type { NoteStore } from "../notes/note.js";
import type { MemoryChangeSetService } from "../memory/memoryChangeSets.js";
import type { ObservabilityReporter } from "../observability/sentry.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import type { PersistenceProviderName } from "../persistence/providerSelection.js";
import type { TotalityPipeline } from "../totality/totalityPipeline.js";
import type { ExternalReconciliationReadStore } from "../reconciliation/externalReconciliation.js";
import type { RuntimeReconciliationHealth } from "../reconciliation/runtimeReconciliationHost.js";
import type { ActivityEventReader } from "../operations/activityTimeline.js";
import type { HttpAppConfig } from "./config.js";
import { ActivityTimelineController } from "./activityTimelineController.js";
import { BriefController } from "./briefController.js";
import { BuildController } from "./buildController.js";
import { BuildLogController } from "./buildLogController.js";
import { UpgradeController } from "./upgradeController.js";
import { AssetController } from "./assetController.js";
import { PreferenceController } from "./preferenceController.js";
import { NoteController } from "./noteController.js";
import { OperationsInboxController } from "./operationsInboxController.js";
import { ErrandController } from "./errandController.js";
import { MemoryChangeSetController } from "./memoryChangeSetController.js";
import { HttpObservabilityInterceptor } from "./observabilityInterceptor.js";
import { ProblemDetailsFilter } from "./problemDetails.js";
import { ClientController } from "./clientController.js";
import { ProjectController } from "./projectController.js";
import { QuoteController } from "./quoteController.js";
import { ReconciliationController } from "./reconciliationController.js";
import { ReminderController } from "./reminderController.js";
import { RequestIdInterceptor } from "./requestId.js";
import { ServiceTokenGuard } from "./serviceTokenGuard.js";
import { HealthController, OperatorSystemController } from "./systemControllers.js";
import { SystemStatusService } from "./systemStatusService.js";
import { TaskController } from "./taskController.js";
import { ToolActionController } from "./toolActionController.js";
import { TotalityController } from "./totalityController.js";
import {
  HTTP_APP_CONFIG,
  HTTP_CLIENT_STORE,
  HTTP_PROJECT_STORE,
  HTTP_QUOTE_STORE,
  HTTP_QUOTE_REPOSITORY,
  HTTP_QUOTE_DELIVERY_REPOSITORY,
  HTTP_ERRAND_STORE,
  HTTP_BUILD_STORE,
  HTTP_BUILD_LOG_STORE,
  HTTP_UPGRADE_STORE,
  HTTP_ASSET_STORE,
  HTTP_PREFERENCE_STORE,
  HTTP_NOTE_STORE,
  HTTP_ACTIVITY_EVENTS,
  HTTP_MEMORY_CHANGE_SETS,
  HTTP_PERSISTENCE,
  HTTP_PROVIDER_NAME,
  HTTP_RECONCILIATION_HEALTH,
  HTTP_EXTERNAL_RECONCILIATION_READ_STORE,
  HTTP_TOOL_ACTIONS,
  HTTP_TOOL_EXECUTION,
  HTTP_OBSERVABILITY_REPORTER,
  HTTP_TOTALITY_PIPELINE,
} from "./tokens.js";

export type JarvisHttpModuleOptions = {
  persistence: PersistenceProvider;
  providerName: PersistenceProviderName;
  reconciliationHealth: () => RuntimeReconciliationHealth;
  externalReconciliationReadStore: ExternalReconciliationReadStore | null;
  config: HttpAppConfig;
  totalityPipeline: TotalityPipeline | null;
  memoryChangeSetService: MemoryChangeSetService | null;
  toolActionService: ToolActionService | null;
  toolExecutionService: ToolExecutionService | null;
  observabilityReporter: ObservabilityReporter;
  clientStore: ClientStore;
  projectStore: ProjectStore;
  quoteStore: QuoteStore;
  quoteRepository: QuoteRepository | null;
  quoteDeliveryRepository: QuoteDeliveryRepository | null;
  errandStore: ErrandStore;
  buildStore: BuildStore;
  buildLogStore: BuildLogStore;
  upgradeStore: UpgradeStore;
  assetStore: AssetStore;
  preferenceStore: PreferenceStore;
  noteStore: NoteStore;
  activityEventReader: ActivityEventReader | null;
};

@Module({})
export class JarvisHttpModule {
  static register(options: JarvisHttpModuleOptions): DynamicModule {
    return {
      module: JarvisHttpModule,
      controllers: [
        HealthController,
        OperatorSystemController,
        TotalityController,
        MemoryChangeSetController,
        TaskController,
        ReminderController,
        ToolActionController,
        ClientController,
        ProjectController,
        QuoteController,
        ReconciliationController,
        ErrandController,
        BuildController,
        BuildLogController,
        UpgradeController,
        AssetController,
        PreferenceController,
        NoteController,
        BriefController,
        OperationsInboxController,
        ActivityTimelineController,
      ],
      providers: [
        { provide: HTTP_APP_CONFIG, useValue: options.config },
        { provide: HTTP_PERSISTENCE, useValue: options.persistence },
        { provide: HTTP_CLIENT_STORE, useValue: options.clientStore },
        { provide: HTTP_PROJECT_STORE, useValue: options.projectStore },
        { provide: HTTP_QUOTE_STORE, useValue: options.quoteStore },
        { provide: HTTP_QUOTE_REPOSITORY, useValue: options.quoteRepository },
        {
          provide: HTTP_QUOTE_DELIVERY_REPOSITORY,
          useValue: options.quoteDeliveryRepository,
        },
        { provide: HTTP_ERRAND_STORE, useValue: options.errandStore },
        { provide: HTTP_BUILD_STORE, useValue: options.buildStore },
        { provide: HTTP_BUILD_LOG_STORE, useValue: options.buildLogStore },
        { provide: HTTP_UPGRADE_STORE, useValue: options.upgradeStore },
        { provide: HTTP_ASSET_STORE, useValue: options.assetStore },
        { provide: HTTP_PREFERENCE_STORE, useValue: options.preferenceStore },
        { provide: HTTP_NOTE_STORE, useValue: options.noteStore },
        { provide: HTTP_ACTIVITY_EVENTS, useValue: options.activityEventReader },
        { provide: HTTP_PROVIDER_NAME, useValue: options.providerName },
        { provide: HTTP_OBSERVABILITY_REPORTER, useValue: options.observabilityReporter },
        {
          provide: HTTP_RECONCILIATION_HEALTH,
          useValue: options.reconciliationHealth,
        },
        {
          provide: HTTP_EXTERNAL_RECONCILIATION_READ_STORE,
          useValue: options.externalReconciliationReadStore,
        },
        { provide: HTTP_TOTALITY_PIPELINE, useValue: options.totalityPipeline },
        {
          provide: HTTP_MEMORY_CHANGE_SETS,
          useValue: options.memoryChangeSetService,
        },
        { provide: HTTP_TOOL_ACTIONS, useValue: options.toolActionService },
        {
          provide: HTTP_TOOL_EXECUTION,
          useValue: options.toolExecutionService,
        },
        SystemStatusService,
        { provide: APP_GUARD, useClass: ServiceTokenGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
        { provide: APP_INTERCEPTOR, useClass: HttpObservabilityInterceptor },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
