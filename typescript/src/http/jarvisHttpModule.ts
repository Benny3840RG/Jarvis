import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import type { ToolActionService } from "../actions/toolActions.js";
import type { MemoryChangeSetService } from "../memory/memoryChangeSets.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import type { PersistenceProviderName } from "../persistence/providerSelection.js";
import type { TotalityPipeline } from "../totality/totalityPipeline.js";
import type { HttpAppConfig } from "./config.js";
import { MemoryChangeSetController } from "./memoryChangeSetController.js";
import { ProblemDetailsFilter } from "./problemDetails.js";
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
  HTTP_MEMORY_CHANGE_SETS,
  HTTP_PERSISTENCE,
  HTTP_PROVIDER_NAME,
  HTTP_TOOL_ACTIONS,
  HTTP_TOTALITY_PIPELINE,
} from "./tokens.js";

export type JarvisHttpModuleOptions = {
  persistence: PersistenceProvider;
  providerName: PersistenceProviderName;
  config: HttpAppConfig;
  totalityPipeline: TotalityPipeline | null;
  memoryChangeSetService: MemoryChangeSetService | null;
  toolActionService: ToolActionService | null;
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
      ],
      providers: [
        { provide: HTTP_APP_CONFIG, useValue: options.config },
        { provide: HTTP_PERSISTENCE, useValue: options.persistence },
        { provide: HTTP_PROVIDER_NAME, useValue: options.providerName },
        { provide: HTTP_TOTALITY_PIPELINE, useValue: options.totalityPipeline },
        { provide: HTTP_MEMORY_CHANGE_SETS, useValue: options.memoryChangeSetService },
        { provide: HTTP_TOOL_ACTIONS, useValue: options.toolActionService },
        SystemStatusService,
        { provide: APP_GUARD, useClass: ServiceTokenGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
