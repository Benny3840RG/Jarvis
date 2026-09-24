import { Body, Controller, Get, Header, HttpCode, Inject, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { renderCredentialsPage } from "../settings/credentialsPage.js";
import {
  decideEndOverlap,
  deliveryDigestCollides,
  parseDeliveryCheckRequest,
  parseEndOverlapRequest,
  type CredentialsRuntime,
  type CredentialsStatus,
} from "../settings/credentialsStatus.js";
import { JarvisProblem } from "./problemDetails.js";
import { PublicRoute } from "./publicRoute.js";
import { HTTP_CREDENTIALS } from "./tokens.js";

function invalidRequest(): never {
  throw new JarvisProblem(
    400,
    "invalid-credentials-request",
    "Invalid Credentials Request",
    "The credentials request could not be processed.",
  );
}

@Controller()
export class CredentialsController {
  constructor(@Inject(HTTP_CREDENTIALS) private readonly credentials: CredentialsRuntime) {}

  @PublicRoute()
  @Get("settings/credentials")
  @Header("Referrer-Policy", "no-referrer")
  page(@Res({ passthrough: true }) reply: FastifyReply): string {
    if (!this.credentials.serveLocalPage) {
      throw new JarvisProblem(
        404,
        "not-found",
        "Not Found",
        "The local credentials page is only served on a loopback bind.",
      );
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
    );
    return renderCredentialsPage(this.credentials.pageModel);
  }

  @Get("api/v1/settings/credentials")
  getStatus(): { data: CredentialsStatus } {
    return { data: this.credentials.status };
  }

  @Post("api/v1/settings/credentials/end-overlap")
  @HttpCode(200)
  endOverlap(@Body() body: unknown): {
    offered: boolean;
    primary: boolean;
    allowed: boolean;
    commands: readonly string[];
  } {
    const parsed = parseEndOverlapRequest(body);
    if (!parsed.ok) invalidRequest();
    const decision = decideEndOverlap(parsed);
    return {
      offered: decision.offered,
      primary: decision.primary,
      allowed: decision.allowed,
      commands: decision.commands,
    };
  }

  @Post("api/v1/settings/credentials/delivery-check")
  @HttpCode(200)
  deliveryCheck(@Body() body: unknown): { equalsServiceToken: boolean } {
    const parsed = parseDeliveryCheckRequest(body);
    if (!parsed.ok) invalidRequest();
    return {
      equalsServiceToken: deliveryDigestCollides(
        parsed.digestSha256,
        this.credentials.serviceDigests,
      ),
    };
  }
}
