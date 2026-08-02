import { Controller, Get, Inject, Query } from "@nestjs/common";

import {
  readActivityTimelinePage,
  type ActivityEventReader,
  type ActivityTimelineResult,
} from "../operations/activityTimeline.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_ACTIVITY_EVENTS } from "./tokens.js";

const DEFAULT_LIMIT = 50;

function parseActivityCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("cursor must be a non-empty string.");
  }
  return value;
}

function parseActivityLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("limit must be an integer between 1 and 100.");
  }
  return parsed;
}

/**
 * Read-only Operations Activity Timeline: a bounded, cursor-paginated,
 * owner-wide feed of durable audit events (see `readActivityTimelinePage`).
 * Unlike the multi-source Operations Inbox, this endpoint has exactly one
 * source, so a read failure (or the source simply not being configured in
 * this deployment) is still reported as `{status: "unavailable", reason}` in
 * the 200 body — never as an empty page, and never as a thrown 503 — so
 * callers only ever need to branch on `data.status`.
 */
@Controller("api/v1/operations/activity")
export class ActivityTimelineController {
  constructor(@Inject(HTTP_ACTIVITY_EVENTS) private readonly reader: ActivityEventReader | null) {}

  @Get()
  async get(
    @Query("cursor") cursorValue: unknown,
    @Query("limit") limitValue: unknown,
  ): Promise<{ data: ActivityTimelineResult }> {
    let cursor: string | null;
    let limit: number;
    try {
      cursor = parseActivityCursor(cursorValue);
      limit = parseActivityLimit(limitValue);
    } catch {
      throw new JarvisProblem(
        422,
        "invalid-activity-query",
        "Invalid Activity Query",
        "The activity timeline query is not supported.",
      );
    }

    if (!this.reader) {
      return {
        data: {
          status: "unavailable",
          reason:
            "The operations activity timeline requires the configured Convex persistence provider.",
        },
      };
    }

    return { data: await readActivityTimelinePage({ reader: this.reader, cursor, limit }) };
  }
}
