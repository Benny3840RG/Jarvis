import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { OpenAIRequestError } from "../integrations/openai/totalityReasoner.js";
import type { TotalityResponse } from "../runtime/totalityContracts.js";
import type {
  TotalityPipeline,
  TotalityReasoningResult,
} from "../totality/totalityPipeline.js";
import { JarvisProblem } from "./problemDetails.js";
import { requestIdFor } from "./requestId.js";
import { HTTP_TOTALITY_PIPELINE } from "./tokens.js";
import { parseTotalityReasonRequest } from "./totalityRequest.js";

function isAuthorityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authority|approval/i.test(message);
}

@Controller("api/v1/totality")
export class TotalityController {
  constructor(
    @Inject(HTTP_TOTALITY_PIPELINE)
    private readonly pipeline: TotalityPipeline | null,
  ) {}

  @Post("reason")
  @HttpCode(200)
  async reason(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<TotalityResponse<TotalityReasoningResult>> {
    if (!this.pipeline) {
      throw new JarvisProblem(
        503,
        "totality-unavailable",
        "Totality Unavailable",
        "Totality reasoning requires configured OpenAI and Convex dependencies.",
      );
    }

    let input;
    try {
      input = parseTotalityReasonRequest(body, requestIdFor(request));
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-totality-request",
        "Invalid Totality Request",
        "The Totality request does not match the supported contract.",
      );
    }

    try {
      return await this.pipeline.run(input);
    } catch (error: unknown) {
      if (error instanceof OpenAIRequestError && error.status === 429) {
        throw new JarvisProblem(
          429,
          "reasoning-rate-limited",
          "Reasoning Rate Limited",
          "The reasoning provider is temporarily rate limited.",
        );
      }
      if (error instanceof OpenAIRequestError) {
        throw new JarvisProblem(
          503,
          "reasoning-dependency-failed",
          "Reasoning Dependency Failed",
          "The configured reasoning provider could not produce a usable response.",
        );
      }
      if (isAuthorityError(error)) {
        throw new JarvisProblem(
          422,
          "authority-policy-violation",
          "Authority Policy Violation",
          "The request exceeds its configured authority envelope.",
        );
      }
      throw new JarvisProblem(
        503,
        "totality-journal-failed",
        "Totality Journal Failed",
        "The reasoning result could not be safely recorded.",
      );
    }
  }
}
