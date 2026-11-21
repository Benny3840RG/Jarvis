import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import type { PersistenceProviderName } from "../persistence/providerSelection.js";
import type { CredentialsRuntime } from "../settings/credentialsStatus.js";
import { renderPersistencePage } from "../settings/persistencePage.js";
import { JarvisProblem } from "./problemDetails.js";
import { PublicRoute } from "./publicRoute.js";
import { HTTP_CREDENTIALS, HTTP_PROVIDER_NAME } from "./tokens.js";

@Controller()
export class PersistencePageController {
  constructor(
    @Inject(HTTP_CREDENTIALS) private readonly credentials: CredentialsRuntime,
    @Inject(HTTP_PROVIDER_NAME) private readonly providerName: PersistenceProviderName,
  ) {}

  @PublicRoute()
  @Get("settings/persistence")
  @Header("Referrer-Policy", "no-referrer")
  page(@Res({ passthrough: true }) reply: FastifyReply): string {
    if (!this.credentials.serveLocalPage) {
      throw new JarvisProblem(
        404,
        "not-found",
        "Not Found",
        "The local persistence page is only served on a loopback bind.",
      );
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
    );
    return renderPersistencePage(this.providerName);
  }
}
