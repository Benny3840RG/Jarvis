import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import type { HttpAppConfig } from "../../http/config.js";
import type { OidcVerifier } from "../../http/oidcVerifier.js";
import { ProblemDetailsFilter } from "../../http/problemDetails.js";
import { RequestIdInterceptor } from "../../http/requestId.js";
import { ServiceTokenGuard } from "../../http/serviceTokenGuard.js";
import { HTTP_APP_CONFIG, HTTP_OIDC_VERIFIER } from "../../http/tokens.js";
import { CommissioningIngressController, COMMISSIONING_INGRESS_RUNNER } from "./controller.js";
import type { CommissioningIngressRunner } from "./ingress.js";

export type CommissioningIngressModuleOptions = {
  config: HttpAppConfig;
  oidcVerifier: OidcVerifier | null;
  runner: CommissioningIngressRunner;
};

/**
 * A minimal Nest module for the isolated-ingress commissioning bootstrap. It
 * reuses the exact production `ServiceTokenGuard` and `ProblemDetailsFilter`,
 * but wires **no** persistence, store, provider or business adapter — the only
 * thing it can do is authenticate a request and hand it to the commissioning
 * ingress runner.
 */
@Module({})
export class CommissioningIngressModule {
  static register(options: CommissioningIngressModuleOptions): DynamicModule {
    return {
      module: CommissioningIngressModule,
      controllers: [CommissioningIngressController],
      providers: [
        { provide: HTTP_APP_CONFIG, useValue: options.config },
        { provide: HTTP_OIDC_VERIFIER, useValue: options.oidcVerifier },
        { provide: COMMISSIONING_INGRESS_RUNNER, useValue: options.runner },
        { provide: APP_GUARD, useClass: ServiceTokenGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
