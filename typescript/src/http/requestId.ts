import { randomUUID } from "node:crypto";

import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Observable } from "rxjs";

export const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function resolveRequestId(
  value: string | string[] | undefined,
  rejectedValues: ReadonlyArray<string | undefined> = [],
): string {
  const candidate = Array.isArray(value) ? undefined : value;
  return candidate !== undefined &&
    SAFE_REQUEST_ID.test(candidate) &&
    !rejectedValues.includes(candidate)
    ? candidate
    : randomUUID();
}

export function requestIdFor(request: Pick<FastifyRequest, "id">): string {
  return SAFE_REQUEST_ID.test(request.id) ? request.id : randomUUID();
}

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    response.header("X-Request-Id", requestIdFor(request));
    response.header("Cache-Control", "no-store");
    response.header("X-Content-Type-Options", "nosniff");
    return next.handle();
  }
}
