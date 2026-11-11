import { createHash, timingSafeEqual } from "node:crypto";

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  EXECUTION_STATUSES,
  OWNER_DECISION_CHOICES,
  type OwnerDecisionChoice,
  type OwnerExecutionStatus,
} from "../ownerGate/ownerDecision.js";
import { renderOwnerDecisionsPage } from "../ownerGate/ownerDecisionPage.js";
import {
  OwnerDecisionRefusal,
  type OwnerDecisionQueue,
  type OwnerDecisionService,
  type RecordedResult,
} from "../ownerGate/ownerDecisionService.js";
import type { CredentialsRuntime } from "../settings/credentialsStatus.js";
import { getAuthenticatedPrincipal } from "./authenticatedPrincipal.js";
import type { HttpAppConfig } from "./config.js";
import { LocalLoopbackRoute } from "./localLoopbackRoute.js";
import { JarvisProblem } from "./problemDetails.js";
import { PublicRoute } from "./publicRoute.js";
import { HTTP_APP_CONFIG, HTTP_CREDENTIALS, HTTP_OWNER_DECISIONS } from "./tokens.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-owner-decision",
    "Invalid Owner Decision",
    detail,
  );
}

function boundedText(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(`${key} must be text of at most ${max} characters.`);
  }
  return value;
}

function optionalText(body: Record<string, unknown>, key: string, max: number): string | undefined {
  return body[key] === undefined ? undefined : boundedText(body, key, max);
}

function parseBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(body)) throw invalid("The request body must be a JSON object.");
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalid("The request body has an unexpected field.");
  }
  return body;
}

function digestField(body: Record<string, unknown>): string {
  const digest = boundedText(body, "expectedDigest", 64);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw invalid("expectedDigest must be a SHA-256 digest.");
  return digest;
}

function idempotencyField(body: Record<string, unknown>): string {
  const key = boundedText(body, "idempotencyKey", 100);
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
    throw invalid("idempotencyKey must be 8 to 100 letters, digits or . _ : - characters.");
  }
  return key;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

const REFUSAL_STATUS: Record<OwnerDecisionRefusal["code"], number> = {
  "not-found": HttpStatus.NOT_FOUND,
  stale: HttpStatus.CONFLICT,
  "subject-changed": HttpStatus.CONFLICT,
  expired: HttpStatus.CONFLICT,
  "not-ready": HttpStatus.CONFLICT,
  "already-decided": HttpStatus.CONFLICT,
  "idempotency-conflict": HttpStatus.CONFLICT,
  "not-approved": HttpStatus.CONFLICT,
  "already-executed": HttpStatus.CONFLICT,
  "execution-unresolved": HttpStatus.CONFLICT,
  "ledger-exists": HttpStatus.CONFLICT,
  "confirmation-required": HttpStatus.UNPROCESSABLE_ENTITY,
  unavailable: HttpStatus.SERVICE_UNAVAILABLE,
};

function toProblem(error: unknown): JarvisProblem {
  if (error instanceof JarvisProblem) return error;
  if (error instanceof OwnerDecisionRefusal) {
    return new JarvisProblem(
      REFUSAL_STATUS[error.code],
      `owner-decision-${error.code}`,
      "Owner Decision Refused",
      error.message,
    );
  }
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "owner-decision-unavailable",
    "Owner Decision Refused",
    "The decision could not be safely recorded.",
  );
}

/**
 * Owner decision queue (#801). Reading is open on a loopback bind, like the
 * HUD snapshot. Recording a decision needs the service token (or the OIDC
 * owner) and, separately, the approval token. Recording executes nothing.
 */
@Controller()
export class OwnerDecisionController {
  constructor(
    @Inject(HTTP_OWNER_DECISIONS) private readonly decisions: OwnerDecisionService,
    @Inject(HTTP_APP_CONFIG) private readonly config: HttpAppConfig,
    @Inject(HTTP_CREDENTIALS) private readonly credentials: CredentialsRuntime,
  ) {}

  @PublicRoute()
  @Get("settings/owner-decisions")
  @Header("Referrer-Policy", "no-referrer")
  page(@Res({ passthrough: true }) reply: FastifyReply): string {
    if (!this.credentials.serveLocalPage) {
      throw new JarvisProblem(
        404,
        "not-found",
        "Not Found",
        "The owner decisions page is only served on a loopback bind.",
      );
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
    return renderOwnerDecisionsPage();
  }

  @LocalLoopbackRoute()
  @Get("api/v1/owner-decisions")
  @Header("Cache-Control", "no-store")
  async list(): Promise<{ data: OwnerDecisionQueue }> {
    return { data: await this.decisions.inspect() };
  }

  private requireApprovalToken(candidate: string): void {
    const current = this.config.currentApprovalToken;
    if (!current) {
      throw new JarvisProblem(
        HttpStatus.SERVICE_UNAVAILABLE,
        "owner-decision-unavailable",
        "Owner Decision Refused",
        "No approval token is configured. The queue is read-only.",
      );
    }
    const digest = sha256(candidate);
    const previous = this.config.previousApprovalToken;
    const matches =
      timingSafeEqual(digest, sha256(current)) ||
      (previous !== undefined && timingSafeEqual(digest, sha256(previous)));
    if (!matches) {
      throw new JarvisProblem(
        HttpStatus.FORBIDDEN,
        "owner-decision-forbidden",
        "Owner Decision Refused",
        "A valid approval token is required to record an owner decision.",
      );
    }
  }

  private actor(request: FastifyRequest): string {
    const principal = getAuthenticatedPrincipal(request);
    return principal === undefined ? "approval-token-holder" : `oidc:${principal.subject}`;
  }

  @Post("api/v1/owner-decisions/ledger")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  async startLedger(@Body() raw: unknown): Promise<{ data: OwnerDecisionQueue }> {
    try {
      const body = parseBody(raw, ["approvalToken", "confirmation"]);
      this.requireApprovalToken(boundedText(body, "approvalToken", 4096));
      if (body.confirmation !== "START NEW LEDGER") {
        throw invalid('Type "START NEW LEDGER" to start a new, empty decision ledger.');
      }
      await this.decisions.startLedger();
      return { data: await this.decisions.inspect() };
    } catch (error: unknown) {
      throw toProblem(error);
    }
  }

  @Post("api/v1/owner-decisions/:decisionId/decisions")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  async decide(
    @Param("decisionId") decisionId: string,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ data: RecordedResult }> {
    try {
      const body = parseBody(raw, [
        "expectedDigest",
        "decision",
        "idempotencyKey",
        "approvalToken",
        "confirmation",
        "note",
      ]);
      const choice = boundedText(body, "decision", 32);
      if (!OWNER_DECISION_CHOICES.includes(choice as OwnerDecisionChoice)) {
        throw invalid("decision must be approve, request-changes or reject.");
      }
      const expectedDigest = digestField(body);
      const idempotencyKey = idempotencyField(body);
      const confirmation = optionalText(body, "confirmation", 200);
      const note = optionalText(body, "note", 1000);
      this.requireApprovalToken(boundedText(body, "approvalToken", 4096));
      return {
        data: await this.decisions.decide({
          decisionId,
          expectedDigest,
          choice: choice as OwnerDecisionChoice,
          idempotencyKey,
          ...(confirmation === undefined ? {} : { confirmation }),
          ...(note === undefined ? {} : { note }),
          actor: this.actor(request),
        }),
      };
    } catch (error: unknown) {
      throw toProblem(error);
    }
  }

  @Post("api/v1/owner-decisions/:decisionId/executions")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  async reportExecution(
    @Param("decisionId") decisionId: string,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ data: RecordedResult }> {
    try {
      const body = parseBody(raw, ["expectedDigest", "status", "idempotencyKey", "reference"]);
      const status = boundedText(body, "status", 32);
      if (!EXECUTION_STATUSES.includes(status as OwnerExecutionStatus)) {
        throw invalid("status must be executed, failed or indeterminate.");
      }
      const reference = optionalText(body, "reference", 400);
      const principal = getAuthenticatedPrincipal(request);
      return {
        data: await this.decisions.reportExecution({
          decisionId,
          expectedDigest: digestField(body),
          status: status as OwnerExecutionStatus,
          idempotencyKey: idempotencyField(body),
          ...(reference === undefined ? {} : { reference }),
          actor: principal === undefined ? "service-token-holder" : `oidc:${principal.subject}`,
        }),
      };
    } catch (error: unknown) {
      throw toProblem(error);
    }
  }
}
