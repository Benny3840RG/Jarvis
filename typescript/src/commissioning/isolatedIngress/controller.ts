import { Body, Controller, HttpStatus, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { JarvisProblem } from "../../http/problemDetails.js";
import { parseIdempotencyKey } from "../../http/taskRequest.js";
import { CommissioningIngressRunner, CommissioningPrincipalError } from "./ingress.js";
import { CommissioningRequestError, parseCommissioningIngressBody } from "./requestSchema.js";
import type { CommissioningDeliveryClassification } from "./evidence.js";

export const COMMISSIONING_INGRESS_RUNNER = Symbol("COMMISSIONING_INGRESS_RUNNER");

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "commissioning-request-invalid",
    "Commissioning Request Invalid",
    detail,
  );
}

function classificationFrom(
  header: string | string[] | undefined,
): CommissioningDeliveryClassification {
  return header === "retry" ? "retry" : "first-attempt";
}

/**
 * The only route the isolated-ingress commissioning bootstrap serves:
 * `POST /commissioning/v1/isolated-ingress`. The global `ServiceTokenGuard`
 * (in `oidc` mode) authenticates it before this handler runs; a forged or
 * invalid identity, or a wrong subject, never reaches here.
 */
@Controller("commissioning/v1")
export class CommissioningIngressController {
  constructor(
    @Inject(COMMISSIONING_INGRESS_RUNNER) private readonly runner: CommissioningIngressRunner,
  ) {}

  @Post("isolated-ingress")
  async admit(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = (() => {
      try {
        return parseCommissioningIngressBody(body);
      } catch (error: unknown) {
        throw invalid(
          error instanceof CommissioningRequestError
            ? error.message
            : "The commissioning ingress body is invalid.",
        );
      }
    })();

    let idempotencyKey: string;
    try {
      idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "Idempotency-Key is invalid.");
    }

    const classification = classificationFrom(request.headers["x-commissioning-attempt"]);

    let outcome;
    try {
      outcome = await this.runner.admit(request, parsed, idempotencyKey, classification);
    } catch (error: unknown) {
      if (error instanceof CommissioningPrincipalError) {
        throw new JarvisProblem(
          HttpStatus.UNAUTHORIZED,
          "unauthorized",
          "Unauthorized",
          "A verified OIDC principal is required.",
        );
      }
      throw error;
    }

    reply.code(outcome.status);
    return {
      disposition: outcome.disposition,
      classification,
      detail: outcome.detail,
      ...(outcome.runId === undefined ? {} : { runId: outcome.runId }),
      ...(outcome.probe === undefined ? {} : { probe: outcome.probe }),
    };
  }
}
