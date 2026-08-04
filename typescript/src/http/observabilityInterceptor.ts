import { performance } from "node:perf_hooks";

import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Observable } from "rxjs";
import { finalize } from "rxjs/operators";

import type { ObservabilityReporter } from "../observability/sentry.js";
import { requestIdFor } from "./requestId.js";
import { HTTP_OBSERVABILITY_REPORTER } from "./tokens.js";

function requestPath(url: string): string {
  const stripped = url.split("?", 1)[0];
  return stripped.startsWith("/") ? stripped : "/";
}

@Injectable()
export class HttpObservabilityInterceptor implements NestInterceptor {
  constructor(
    @Inject(HTTP_OBSERVABILITY_REPORTER)
    private readonly reporter: ObservabilityReporter,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const startedAt = performance.now();

    return next.handle().pipe(
      finalize(() => {
        void this.reporter.recordHttpRequest({
          method: request.method,
          path: requestPath(request.url),
          statusCode: response.statusCode,
          durationMs: performance.now() - startedAt,
          requestId: requestIdFor(request),
        });
      }),
    );
  }
}
