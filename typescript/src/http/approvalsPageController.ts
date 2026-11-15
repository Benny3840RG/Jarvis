import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { APPROVALS_PAGE_HREF, renderApprovalsPage } from "../approvals/approvalsPage.js";
import type { CredentialsRuntime } from "../settings/credentialsStatus.js";
import { JarvisProblem } from "./problemDetails.js";
import { PublicRoute } from "./publicRoute.js";
import { HTTP_CREDENTIALS } from "./tokens.js";

/**
 * The Approvals page: a token-free shell on a loopback bind only. It adds no
 * route and no authority of its own; the page calls the existing tool-action
 * routes with the service token, and approval still needs the approval token.
 */
@Controller()
export class ApprovalsPageController {
  constructor(@Inject(HTTP_CREDENTIALS) private readonly credentials: CredentialsRuntime) {}

  @PublicRoute()
  @Get(APPROVALS_PAGE_HREF.slice(1))
  @Header("Referrer-Policy", "no-referrer")
  page(@Res({ passthrough: true }) reply: FastifyReply): string {
    if (!this.credentials.serveLocalPage) {
      throw new JarvisProblem(
        404,
        "not-found",
        "Not Found",
        "The approvals page is only served on a loopback bind.",
      );
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
    return renderApprovalsPage();
  }
}
