import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import { isInvalidIdError, type ConvexClientLike } from "../persistence/convexPersistence.js";
import type {
  BuildLogEntry,
  BuildLogInput,
  BuildLogKind,
  BuildLogStore,
  BuildLogUpdate,
} from "./buildLogEntry.js";

export const buildLogFunctions = api.buildLogs;

type BuildLogRow = {
  _id: string;
  buildId: string;
  kind: BuildLogKind;
  title: string;
  body?: string;
  occurredAt?: number;
  createdAt: number;
  updatedAt?: number;
};

function entryFromConvex(row: BuildLogRow): BuildLogEntry {
  return {
    id: row._id,
    buildId: row.buildId,
    kind: row.kind,
    title: row.title,
    ...(row.body === undefined ? {} : { body: row.body }),
    ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
    createdAt: row.createdAt,
    ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
  };
}

/**
 * Convex-backed BuildLogStore. Selected when PERSISTENCE_PROVIDER=convex so a
 * build's lore lives in the same durable deployment as the build it belongs to.
 * Owner-scoped and authenticated by the shared service token.
 */
export class ConvexBuildLogStore implements BuildLogStore {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) {
      throw new Error(
        "PERSISTENCE_PROVIDER=convex requires JARVIS_SERVICE_TOKEN. The deployment URL is not authentication.",
      );
    }
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      throw new Error(
        "PERSISTENCE_PROVIDER=convex requires CONVEX_URL to be set in the environment.",
      );
    }
    this.client = new ConvexHttpClient(convexUrl);
  }

  async list(): Promise<BuildLogEntry[]> {
    const rows = await this.client.query(buildLogFunctions.list, {
      serviceToken: this.serviceToken,
    });
    return rows.map(entryFromConvex);
  }

  async get(id: string): Promise<BuildLogEntry | null> {
    const row = await this.client.query(buildLogFunctions.get, {
      serviceToken: this.serviceToken,
      id,
    });
    return row === null ? null : entryFromConvex(row);
  }

  async add(input: BuildLogInput): Promise<BuildLogEntry> {
    const row = await this.client.mutation(buildLogFunctions.create, {
      serviceToken: this.serviceToken,
      buildId: input.buildId,
      title: input.title,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    });
    return entryFromConvex(row);
  }

  async update(id: string, update: BuildLogUpdate): Promise<BuildLogEntry | null> {
    try {
      const row = await this.client.mutation(buildLogFunctions.update, {
        serviceToken: this.serviceToken,
        id,
        ...(update.buildId === undefined ? {} : { buildId: update.buildId }),
        ...(update.kind === undefined ? {} : { kind: update.kind }),
        ...(update.title === undefined ? {} : { title: update.title }),
        ...nullableArg("body", update.body),
        ...nullableArg("occurredAt", update.occurredAt),
      });
      return row === null ? null : entryFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }

  async remove(id: string): Promise<BuildLogEntry | null> {
    try {
      const row = await this.client.mutation(buildLogFunctions.remove, {
        serviceToken: this.serviceToken,
        id,
      });
      return row === null ? null : entryFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }
}

/**
 * Translates a nullable update field into Convex args: undefined omits it, null
 * becomes a `clear<Field>` flag, and a value is passed through.
 */
function nullableArg(
  field: "body" | "occurredAt",
  value: string | number | null | undefined,
): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  const clearKey = `clear${field.charAt(0).toUpperCase()}${field.slice(1)}`;
  return value === null ? { [clearKey]: true } : { [field]: value };
}
