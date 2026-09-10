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

export function redactedRequestPath(url: string, config: HttpAppConfig): string {
  const path = url.split("?", 1)[0];
  return redact(path.startsWith("/") ? path : "/", configuredSecrets(config), "redacted");
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

// A response must not spend unbounded work matching caller-controlled text.
// On exhaustion suppress the whole field, never return potentially secret text.
const MAX_REDACTION_WORK = 100_000;

function redact(
  value: string,
  secrets: Array<string | undefined>,
  replacement = "[REDACTED]",
): string {
  // A replacement marker is output too. If it contains any configured
  // credential, substituting it would reproduce that credential verbatim.
  // Suppress the whole field instead of trying to invent a second marker.
  if (secrets.some((secret) => secret && replacement.includes(secret))) return "";

  let result = value;
  let remainingWork = MAX_REDACTION_WORK;
  for (const secret of secrets) {
    if (!secret) continue;
    remainingWork -= result.length + secret.length;
    if (remainingWork < 0) return replacement;
    const characters = [...secret].map((literal) => ({
      literal,
      encoded: [...Buffer.from(literal)]
        .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
        .join(""),
    }));
    let copiedThrough = 0;
    const output: string[] = [];
    for (let start = 0; start < result.length; start++) {
      // Keep all possible offsets when a literal percent also begins an
      // encoded character. Explicit work accounting bounds that ambiguity.
      let positions = new Set([start]);
      for (const { literal, encoded } of characters) {
        const next = new Set<number>();
        for (const position of positions) {
          if (--remainingWork < 0) return replacement;
          if (result.startsWith(literal, position)) next.add(position + literal.length);
          if (
            result[position] === "%" &&
            result.slice(position, position + encoded.length).toLowerCase() === encoded
          )
            next.add(position + encoded.length);
        }
        positions = next;
        if (positions.size === 0) break;
      }
      if (positions.size === 0) continue;
      let end = start;
      for (const position of positions) end = Math.max(end, position);
      output.push(result.slice(copiedThrough, start), replacement);
      copiedThrough = end;
      start = end - 1;
    }
    output.push(result.slice(copiedThrough));
    result = output.join("");
  }
  return result;
}

/**
 * Every bearer credential this config carries, so no response body can echo one
 * back. The approval tokens gate tool *execution* approval
 * (`toolActionController.ts`), so omitting them from redaction while redacting
 * the service tokens protected the lower-value credential and not the higher-value
 * one. Anything added to `HttpAppConfig` that is a secret belongs here too.
 */
export function configuredSecrets(config: HttpAppConfig): string[] {
  return [
    config.currentToken,
    config.previousToken,
    config.currentApprovalToken,
    config.previousApprovalToken,
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
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
      detail: redact(definition.detail, configuredSecrets(this.config)),
      instance: redactedRequestPath(request.url, this.config),
      requestId,
    };

    response.header("X-Request-Id", requestId);
    response.header("Cache-Control", "no-store");
    response.header("X-Content-Type-Options", "nosniff");
    if (status === HttpStatus.UNAUTHORIZED) response.header("WWW-Authenticate", "Bearer");
    response.status(status).type("application/problem+json").send(details);
  }
}
