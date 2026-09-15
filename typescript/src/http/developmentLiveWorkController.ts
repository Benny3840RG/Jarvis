import { Controller, Get, Inject } from "@nestjs/common";

import {
  readLiveWorkPipeline,
  type DevelopmentLiveWorkSource,
  type LiveWorkResult,
} from "../development/liveWork.js";
import { HTTP_DEVELOPMENT_LIVE_WORK } from "./tokens.js";

/**
 * Read-only development live-work pipeline: the single mission currently in
 * flight, folded into the operator HUD's MISSION -> STAGE -> ISSUE -> PR ->
 * WORKER -> REVIEW -> CI -> MERGE -> OMEGA nodes.
 *
 * Like the Operations Activity Timeline, this endpoint has exactly one source,
 * so a source that is simply not configured in this deployment (JSON
 * persistence) is reported as `{status: "unavailable", reason}` in the 200
 * body — never a thrown 503, and never a fabricated empty pipeline. "No
 * mission in flight" is a successful available read with a null pipeline.
 */
@Controller("api/v1/development/live-work")
export class DevelopmentLiveWorkController {
  constructor(
    @Inject(HTTP_DEVELOPMENT_LIVE_WORK)
    private readonly source: DevelopmentLiveWorkSource | null,
  ) {}

  @Get()
  async get(): Promise<{ data: LiveWorkResult }> {
    if (!this.source) {
      return {
        data: {
          status: "unavailable",
          reason: "Development Live Work requires configured Convex persistence.",
        },
      };
    }
    return { data: await readLiveWorkPipeline({ source: this.source }) };
  }
}
