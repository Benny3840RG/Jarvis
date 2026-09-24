import { Body, Controller, Get, Header, HttpCode, Inject, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { renderCredentialsPage, renderDangerPage } from "../settings/credentialsPage.js";
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

  @PublicRoute()
  @Get("settings/danger")
  @Header("Referrer-Policy", "no-referrer")
  danger(@Res({ passthrough: true }) reply: FastifyReply): string {
    if (!this.credentials.serveLocalPage) {
      throw new JarvisProblem(
        404,
        "not-found",
        "Not Found",
        "The local danger page is only served on a loopback bind.",
      );
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
    );
    return renderDangerPage();
  }

  @Get("api/v1/settings/credentials")
  getStatus(): { data: CredentialsStatus } {
    return { data: this.credentials.status };
  }

  @Post("api/v1/settings/credentials/end-overlap")
  @HttpCode(200)
  endOverlap(@Body() body: unknown): {
    offered: false;
    primary: false;
    allowed: false;
    executesRemoval: false;
    commands: readonly string[];
    posture: "not-verified" | "guarding";
    dangerHref:
      "/settings/danger#service" | "/settings/danger#approval" | "/settings/danger#delivery";
  } {
    const parsed = parseEndOverlapRequest(body);
    if (!parsed.ok) invalidRequest();
    // This process does not observe smoke. Client verify is not attestation.
    return decideEndOverlap(parsed, { attestedPassing: false });
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
