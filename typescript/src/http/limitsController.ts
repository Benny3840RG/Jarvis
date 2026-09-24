import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { renderLimitsPage } from "../settings/limits/page.js";
import { readProviderQuotaLimits } from "../settings/limits/readModel.js";
import type { CredentialsRuntime } from "../settings/credentialsStatus.js";
import { JarvisProblem } from "./problemDetails.js";
import { PublicRoute } from "./publicRoute.js";
import { HTTP_CREDENTIALS } from "./tokens.js";

@Controller()
export class LimitsController {
  constructor(@Inject(HTTP_CREDENTIALS) private readonly credentials: CredentialsRuntime) {}

  @PublicRoute()
  @Get("settings/limits")
  @Header("Referrer-Policy", "no-referrer")
  page(@Res({ passthrough: true }) reply: FastifyReply): string {
    if (!this.credentials.serveLocalPage) {
      throw new JarvisProblem(
        404,
        "not-found",
        "Not Found",
        "The local limits page is only served on a loopback bind.",
      );
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
    );
    return renderLimitsPage(readProviderQuotaLimits());
  }
}
