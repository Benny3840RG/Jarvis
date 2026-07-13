import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import type { PersistenceProvider } from "../persistence/persistence.js";
import type { PersistenceProviderName } from "../persistence/providerSelection.js";
import type { HttpAppConfig } from "./config.js";
import { ProblemDetailsFilter } from "./problemDetails.js";
import { RequestIdInterceptor } from "./requestId.js";
import { ServiceTokenGuard } from "./serviceTokenGuard.js";
import { HealthController, OperatorSystemController } from "./systemControllers.js";
import { SystemStatusService } from "./systemStatusService.js";
import { HTTP_APP_CONFIG, HTTP_PERSISTENCE, HTTP_PROVIDER_NAME } from "./tokens.js";

export type JarvisHttpModuleOptions = {
  persistence: PersistenceProvider;
  providerName: PersistenceProviderName;
  config: HttpAppConfig;
};

@Module({})
export class JarvisHttpModule {
  static register(options: JarvisHttpModuleOptions): DynamicModule {
    return {
      module: JarvisHttpModule,
      controllers: [HealthController, OperatorSystemController],
      providers: [
        { provide: HTTP_APP_CONFIG, useValue: options.config },
        { provide: HTTP_PERSISTENCE, useValue: options.persistence },
        { provide: HTTP_PROVIDER_NAME, useValue: options.providerName },
        SystemStatusService,
        { provide: APP_GUARD, useClass: ServiceTokenGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
