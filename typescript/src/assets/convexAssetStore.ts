import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import { isInvalidIdError, type ConvexClientLike } from "../persistence/convexPersistence.js";
import type { Asset, AssetInput, AssetStore, AssetUpdate } from "./asset.js";

export const assetFunctions = api.assets;

type AssetRow = {
  _id: string;
  name: string;
  kind: string;
  serviceIntervalDays?: number;
  lastServicedAt?: number;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

function assetFromConvex(row: AssetRow): Asset {
  return {
    id: row._id,
    name: row.name,
    kind: row.kind,
    ...(row.serviceIntervalDays === undefined
      ? {}
      : { serviceIntervalDays: row.serviceIntervalDays }),
    ...(row.lastServicedAt === undefined ? {} : { lastServicedAt: row.lastServicedAt }),
    ...(row.notes === undefined ? {} : { notes: row.notes }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Convex-backed AssetStore. Selected when PERSISTENCE_PROVIDER=convex, so Benny's
 * kit and its service history live in the same durable deployment as the rest of
 * his memory. The store persists only raw fields; the HTTP layer still derives
 * nextDueAt/due from them. Owner-scoped and authenticated by the shared token.
 */
export class ConvexAssetStore implements AssetStore {
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

  async list(): Promise<Asset[]> {
    const rows = await this.client.query(assetFunctions.list, {
      serviceToken: this.serviceToken,
    });
    return rows.map(assetFromConvex);
  }

  async get(id: string): Promise<Asset | null> {
    const row = await this.client.query(assetFunctions.get, {
      serviceToken: this.serviceToken,
      id,
    });
    return row === null ? null : assetFromConvex(row);
  }

  async add(input: AssetInput): Promise<Asset> {
    const row = await this.client.mutation(assetFunctions.create, {
      serviceToken: this.serviceToken,
      name: input.name,
      kind: input.kind,
      ...(input.serviceIntervalDays === undefined
        ? {}
        : { serviceIntervalDays: input.serviceIntervalDays }),
      ...(input.lastServicedAt === undefined ? {} : { lastServicedAt: input.lastServicedAt }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    });
    return assetFromConvex(row);
  }

  async update(id: string, update: AssetUpdate): Promise<Asset | null> {
    try {
      const row = await this.client.mutation(assetFunctions.update, {
        serviceToken: this.serviceToken,
        id,
        ...(update.name === undefined ? {} : { name: update.name }),
        ...(update.kind === undefined ? {} : { kind: update.kind }),
        ...nullableArg("serviceIntervalDays", update.serviceIntervalDays),
        ...nullableArg("lastServicedAt", update.lastServicedAt),
        ...nullableArg("notes", update.notes),
      });
      return row === null ? null : assetFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }

  async remove(id: string): Promise<Asset | null> {
    try {
      const row = await this.client.mutation(assetFunctions.remove, {
        serviceToken: this.serviceToken,
        id,
      });
      return row === null ? null : assetFromConvex(row);
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
  field: "serviceIntervalDays" | "lastServicedAt" | "notes",
  value: string | number | null | undefined,
): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  const clearKey = `clear${field.charAt(0).toUpperCase()}${field.slice(1)}`;
  return value === null ? { [clearKey]: true } : { [field]: value };
}
