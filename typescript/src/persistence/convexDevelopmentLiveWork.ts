import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { z } from "zod";

import { api } from "../../convex/_generated/api.js";
import {
  DevelopmentLiveWorkUnavailableError,
  type DevelopmentLiveWorkSource,
  type LiveWorkSnapshot,
} from "../development/liveWork.js";
import {
  DEVELOPMENT_TRANSITIONS,
  type DevelopmentState,
} from "../development/transitionRegistry.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const developmentStateFunctions = api.developmentState;

const states = new Set<string>(
  Object.values(DEVELOPMENT_TRANSITIONS).flatMap((transition) => [
    ...transition.sources,
    transition.target,
  ]),
);
const developmentState = z.custom<DevelopmentState>(
  (value) => typeof value === "string" && states.has(value),
);
const text = (max = 512) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        ![...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    );
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().finite().nonnegative().max(8.64e15);
const dateTime = z
  .string()
  .max(64)
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
// Object schemas explicitly project allowed fields; unknown credentials and payloads are stripped.
const snapshotSchema = z.object({
  candidate: z
    .object({
      pullRequestNumber: count.positive(),
      headSha: z.string().regex(/^[a-f0-9]{40}$/i),
      receiptId: text(),
    })
    .nullable()
    .optional(),
  subject: z.object({
    subjectId: text(),
    state: developmentState,
    repository: text().optional(),
    branch: text().optional(),
    subjectVersion: count.optional(),
    orchestrationRunId: text().optional(),
    orchestrationNodeId: text().optional(),
    fencingToken: count.optional(),
    updatedAt: timestamp,
  }),
  events: z
    .array(
      z.object({
        eventId: text(),
        evidenceIds: z.array(text()).max(128).optional(),
        eventType: text(),
        transitionId: text().optional(),
        occurredAt: dateTime,
        from: developmentState.optional(),
        to: developmentState.optional(),
        reasonCodes: z.array(text()).max(128),
        hasMergeReceipt: z.boolean(),
      }),
    )
    .max(128),
  omegaMission: z
    .object({
      missionId: text(),
      objective: z.string().min(1).max(4096),
      state: text(64),
      acceptanceCriteria: z.array(z.object({ status: text(64) })).max(64),
    })
    .nullable(),
  workerStep: z
    .object({
      nodeId: text(),
      operationId: text().nullable().optional(),
      state: text(64),
      leaseOwner: text().nullable().optional(),
      leaseExpiresAt: timestamp.nullable().optional(),
    })
    .nullable(),
  omegaReadiness: z
    .object({ allowed: z.boolean(), failures: z.array(text()).max(128) })
    .refine((decision) => decision.allowed === (decision.failures.length === 0))
    .optional(),
  generatedAt: dateTime,
});

/** Validates and projects the bounded read-only query response before operator rendering. */
export class ConvexDevelopmentLiveWorkSource implements DevelopmentLiveWorkSource {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) throw new Error("Live-work pipeline requires JARVIS_SERVICE_TOKEN.");
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Live-work pipeline requires CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async readLiveWorkSnapshot(): Promise<LiveWorkSnapshot | null> {
    let snapshot: unknown;
    try {
      snapshot = await this.client.query(developmentStateFunctions.liveWork, {
        serviceToken: this.serviceToken,
      });
    } catch (error) {
      if (
        error instanceof ConvexError &&
        typeof error.data === "object" &&
        error.data !== null &&
        "code" in error.data &&
        error.data.code === "DEVELOPMENT_LIVE_WORK_AMBIGUOUS"
      ) {
        throw new DevelopmentLiveWorkUnavailableError(
          "Multiple Development subjects are active; live work is ambiguous.",
        );
      }
      throw error;
    }
    if (snapshot === null) return null;
    const result = snapshotSchema.safeParse(snapshot);
    if (!result.success) throw new Error("Invalid live-work snapshot.");
    return result.data;
  }
}
