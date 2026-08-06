import { createHash, timingSafeEqual } from "node:crypto";

import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import type { HttpAppConfig } from "./config.js";
import type { OidcVerifier } from "./oidcVerifier.js";
import { JarvisProblem } from "./problemDetails.js";
import { PUBLIC_ROUTE } from "./publicRoute.js";
import { HTTP_APP_CONFIG, HTTP_OIDC_VERIFIER } from "./tokens.js";

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

function unauthorized(detail: string): never {
  throw new JarvisProblem(HttpStatus.UNAUTHORIZED, "unauthorized", "Unauthorized", detail);
}

function forbidden(detail: string): never {
  throw new JarvisProblem(HttpStatus.FORBIDDEN, "forbidden", "Forbidden", detail);
}

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  private readonly logger = new Logger(ServiceTokenGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig,
    @Inject(HTTP_OIDC_VERIFIER) private readonly oidcVerifier: OidcVerifier | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const candidate = parseBearerToken(request.headers.authorization);

    if (this.config.authMode === "oidc") {
      if (this.oidcVerifier === null) {
        throw new JarvisProblem(
          HttpStatus.SERVICE_UNAVAILABLE,
          "authentication-unavailable",
          "Service Authentication Unavailable",
          "OIDC authentication is not configured.",
        );
      }
      if (candidate === undefined) unauthorized("A valid Bearer OIDC access token is required.");
      let identity;
      try {
        identity = await this.oidcVerifier.verify(candidate);
      } catch {
        this.logger.warn(`Rejected an invalid OIDC access token from ${request.ip}.`);
        unauthorized("A valid Bearer OIDC access token is required.");
      }
      if (identity.subject !== this.config.oidc?.subject) {
        this.logger.warn(`Rejected an authenticated OIDC subject from ${request.ip}.`);
        forbidden("The authenticated OIDC subject is not authorised for this Jarvis owner.");
      }
      return true;
    }

    if (this.config.currentToken === undefined) {
      throw new JarvisProblem(
        HttpStatus.SERVICE_UNAVAILABLE,
        "authentication-unavailable",
        "Service Authentication Unavailable",
        "Jarvis service authentication is not configured.",
      );
    }

    if (
      candidate === undefined ||
      !matchesConfiguredToken(candidate, this.config.currentToken, this.config.previousToken)
    ) {
      // Never logs the candidate or configured token — only that a rejection
      // happened and where from — so this is safe to leave on for brute-force
      // detection without becoming a secondary leak surface.
      this.logger.warn(`Rejected an invalid Bearer service token from ${request.ip}.`);
      unauthorized("A valid Bearer service token is required.");
    }

    return true;
  }
}
