import { createHash, timingSafeEqual } from "node:crypto";

import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import type { HttpAppConfig } from "./config.js";
import { JarvisProblem } from "./problemDetails.js";
import { PUBLIC_ROUTE } from "./publicRoute.js";
import { HTTP_APP_CONFIG } from "./tokens.js";

function parseBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1];
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function matchesConfiguredToken(
  candidate: string,
  currentToken: string,
  previousToken: string | undefined,
): boolean {
  const candidateDigest = digest(candidate);
  const currentMatch = timingSafeEqual(candidateDigest, digest(currentToken));
  const previousMatch =
    previousToken === undefined ? false : timingSafeEqual(candidateDigest, digest(previousToken));
  return currentMatch || previousMatch;
}

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (this.config.currentToken === undefined) {
      throw new JarvisProblem(
        HttpStatus.SERVICE_UNAVAILABLE,
        "authentication-unavailable",
        "Service Authentication Unavailable",
        "Jarvis service authentication is not configured.",
      );
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const candidate = parseBearerToken(request.headers.authorization);
    if (
      candidate === undefined ||
      !matchesConfiguredToken(candidate, this.config.currentToken, this.config.previousToken)
    ) {
      throw new JarvisProblem(
        HttpStatus.UNAUTHORIZED,
        "unauthorized",
        "Unauthorized",
        "A valid Bearer service token is required.",
      );
    }

    return true;
  }
}
