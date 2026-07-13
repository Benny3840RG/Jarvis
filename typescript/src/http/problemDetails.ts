import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException, HttpStatus, Inject } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { HttpAppConfig } from "./config.js";
import { requestIdFor } from "./requestId.js";
import { HTTP_APP_CONFIG } from "./tokens.js";

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
};

type ProblemDefinition = {
  slug: string;
  title: string;
  detail: string;
};

const DEFAULT_PROBLEMS: Record<number, ProblemDefinition> = {
  400: {
    slug: "bad-request",
    title: "Bad Request",
    detail: "The request could not be processed.",
  },
  401: {
    slug: "unauthorized",
    title: "Unauthorized",
    detail: "A valid Bearer service token is required.",
  },
  403: {
    slug: "forbidden",
    title: "Forbidden",
    detail: "The request is not permitted.",
  },
  404: {
    slug: "not-found",
    title: "Not Found",
    detail: "The requested resource does not exist.",
  },
  405: {
    slug: "method-not-allowed",
    title: "Method Not Allowed",
    detail: "The requested method is not supported for this resource.",
  },
  413: {
    slug: "payload-too-large",
    title: "Payload Too Large",
    detail: "The request payload exceeds the supported limit.",
  },
  422: {
    slug: "unprocessable-entity",
    title: "Unprocessable Entity",
    detail: "The request violates Jarvis validation or safety rules.",
  },
  429: {
    slug: "too-many-requests",
    title: "Too Many Requests",
    detail: "The caller has exceeded the configured request rate.",
  },
  503: {
    slug: "service-unavailable",
    title: "Service Unavailable",
    detail: "A required Jarvis dependency is unavailable.",
  },
};

const INTERNAL_PROBLEM: ProblemDefinition = {
  slug: "internal-server-error",
  title: "Internal Server Error",
  detail: "Jarvis could not complete the request.",
};

export class JarvisProblem extends HttpException {
  constructor(
    status: number,
    readonly slug: string,
    readonly problemTitle: string,
    readonly safeDetail: string,
  ) {
    super(safeDetail, status);
  }
}

function requestPath(url: string): string {
  const path = url.split("?", 1)[0];
  return path.startsWith("/") ? path : "/";
}

function safeStatus(exception: unknown): number {
  if (!(exception instanceof HttpException)) return HttpStatus.INTERNAL_SERVER_ERROR;
  const status = exception.getStatus();
  return status >= 400 && status <= 599 ? status : HttpStatus.INTERNAL_SERVER_ERROR;
}

function definitionFor(exception: unknown, status: number): ProblemDefinition {
  if (exception instanceof JarvisProblem) {
    return {
      slug: exception.slug,
      title: exception.problemTitle,
      detail: exception.safeDetail,
    };
  }
  return DEFAULT_PROBLEMS[status] ?? INTERNAL_PROBLEM;
}

function redact(
  value: string,
  secrets: Array<string | undefined>,
  replacement = "[REDACTED]",
): string {
  let result = value;
  for (const secret of secrets) {
    if (secret !== undefined) result = result.split(secret).join(replacement);
  }
  return result;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(@Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const response = context.getResponse<FastifyReply>();
    const status = safeStatus(exception);
    const definition = definitionFor(exception, status);
    const requestId = requestIdFor(request);
    const details: ProblemDetails = {
      type: `urn:jarvis:problem:${definition.slug}`,
      title: definition.title,
      status,
      detail: redact(definition.detail, [this.config.currentToken, this.config.previousToken]),
      instance: redact(
        requestPath(request.url),
        [this.config.currentToken, this.config.previousToken],
        "redacted",
      ),
      requestId,
    };

    response.header("X-Request-Id", requestId);
    response.header("Cache-Control", "no-store");
    response.header("X-Content-Type-Options", "nosniff");
    if (status === HttpStatus.UNAUTHORIZED) response.header("WWW-Authenticate", "Bearer");
    response.status(status).type("application/problem+json").send(details);
  }
}
