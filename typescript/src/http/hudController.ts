import { readFileSync } from "node:fs";

import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import type { AssetStore } from "../assets/asset.js";
import type { DevelopmentLiveWorkSource } from "../development/liveWork.js";
import type { EnquiryStore } from "../enquiries/enquiry.js";
import type { ErrandStore } from "../errands/errand.js";
import type { InvoiceStore } from "../invoices/invoice.js";
import type { ActivityEventReader } from "../operations/activityTimeline.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import type { ProjectStore } from "../projects/project.js";
import type { QuoteStore } from "../quotes/quote.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import type { CredentialsRuntime } from "../settings/credentialsStatus.js";
import type { HttpAppConfig } from "./config.js";
import { readHudSnapshot } from "./hudSnapshot.js";
import { JarvisProblem } from "./problemDetails.js";
import { PublicRoute } from "./publicRoute.js";
import { SystemStatusService } from "./systemStatusService.js";
import {
  HTTP_ACTIVITY_EVENTS,
  HTTP_APP_CONFIG,
  HTTP_ASSET_STORE,
  HTTP_CREDENTIALS,
  HTTP_DEVELOPMENT_LIVE_WORK,
  HTTP_ENQUIRY_STORE,
  HTTP_ERRAND_STORE,
  HTTP_INVOICE_STORE,
  HTTP_PERSISTENCE,
  HTTP_PROJECT_STORE,
  HTTP_QUOTE_REPOSITORY,
  HTTP_QUOTE_STORE,
} from "./tokens.js";

const HUD_HTML = readFileSync(new URL("../mcp/dashboard-v1.html", import.meta.url), "utf8");

const HUD_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'";

function loopbackOnly(): JarvisProblem {
  return new JarvisProblem(
    404,
    "not-found",
    "Not Found",
    "The local HUD is only served on a loopback bind.",
  );
}

@Controller()
export class HudController {
  constructor(
    @Inject(HTTP_CREDENTIALS) private readonly credentials: CredentialsRuntime,
    @Inject(SystemStatusService) private readonly status: SystemStatusService,
    @Inject(HTTP_PERSISTENCE) private readonly persistence: PersistenceProvider,
    @Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig,
    @Inject(HTTP_PROJECT_STORE) private readonly projects: ProjectStore,
    @Inject(HTTP_QUOTE_STORE) private readonly quotes: QuoteStore,
    @Inject(HTTP_ASSET_STORE) private readonly assets: AssetStore,
    @Inject(HTTP_ENQUIRY_STORE) private readonly enquiries: EnquiryStore,
    @Inject(HTTP_INVOICE_STORE) private readonly invoices: InvoiceStore,
    @Inject(HTTP_ERRAND_STORE) private readonly errands: ErrandStore,
    @Inject(HTTP_QUOTE_REPOSITORY) private readonly quoteRepository: QuoteRepository | null,
    @Inject(HTTP_ACTIVITY_EVENTS) private readonly activity: ActivityEventReader | null,
    @Inject(HTTP_DEVELOPMENT_LIVE_WORK)
    private readonly liveWork: DevelopmentLiveWorkSource | null,
  ) {}

  @PublicRoute()
  @Get("hud")
  @Header("Referrer-Policy", "no-referrer")
  page(@Res({ passthrough: true }) reply: FastifyReply): string {
    if (!this.credentials.serveLocalPage) throw loopbackOnly();
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", HUD_CSP);
    return HUD_HTML;
  }

  @PublicRoute()
  @Get("api/v1/hud/snapshot")
  @Header("Referrer-Policy", "no-referrer")
  @Header("Cache-Control", "no-store")
  async snapshot(): Promise<Awaited<ReturnType<typeof readHudSnapshot>>> {
    if (!this.credentials.serveLocalPage) throw loopbackOnly();
    return readHudSnapshot({
      status: this.status,
      persistence: this.persistence,
      config: this.config,
      projects: this.projects,
      quotes: this.quotes,
      assets: this.assets,
      enquiries: this.enquiries,
      invoices: this.invoices,
      errands: this.errands,
      quoteRepository: this.quoteRepository,
      activity: this.activity,
      liveWork: this.liveWork,
      credentials: this.credentials,
    });
  }
}
