import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import { isInvalidIdError, type ConvexClientLike } from "../persistence/convexPersistence.js";
import type { Upgrade, UpgradeInput, UpgradeStore, UpgradeUpdate } from "./upgrade.js";

export const upgradeFunctions = api.upgrades;

type UpgradeRow = {
  _id: string;
  buildId: string;
  title: string;
  reason?: string;
  beforeState?: string;
  afterState?: string;
  outcome?: string;
  parts?: string[];
  version?: string;
  occurredAt?: number;
  createdAt: number;
  updatedAt?: number;
};

function upgradeFromConvex(row: UpgradeRow): Upgrade {
  return {
    id: row._id,
    buildId: row.buildId,
    title: row.title,
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    ...(row.beforeState === undefined ? {} : { beforeState: row.beforeState }),
    ...(row.afterState === undefined ? {} : { afterState: row.afterState }),
    ...(row.outcome === undefined ? {} : { outcome: row.outcome }),
    ...(row.parts === undefined ? {} : { parts: row.parts }),
    ...(row.version === undefined ? {} : { version: row.version }),
    ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
    createdAt: row.createdAt,
    ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
  };
}

/**
 * Convex-backed UpgradeStore. Selected when PERSISTENCE_PROVIDER=convex, so a
 * build's upgrade chronicle lives in the same durable deployment as the build it
 * belongs to. Owner-scoped and authenticated by the shared service token.
 */
export class ConvexUpgradeStore implements UpgradeStore {
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

  async list(): Promise<Upgrade[]> {
    const rows = await this.client.query(upgradeFunctions.list, {
      serviceToken: this.serviceToken,
    });
    return rows.map(upgradeFromConvex);
  }

  async get(id: string): Promise<Upgrade | null> {
    const row = await this.client.query(upgradeFunctions.get, {
      serviceToken: this.serviceToken,
      id,
    });
    return row === null ? null : upgradeFromConvex(row);
  }

  async add(input: UpgradeInput): Promise<Upgrade> {
    const row = await this.client.mutation(upgradeFunctions.create, {
      serviceToken: this.serviceToken,
      buildId: input.buildId,
      title: input.title,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.beforeState === undefined ? {} : { beforeState: input.beforeState }),
      ...(input.afterState === undefined ? {} : { afterState: input.afterState }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.parts === undefined ? {} : { parts: input.parts }),
      ...(input.version === undefined ? {} : { version: input.version }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    });
    return upgradeFromConvex(row);
  }

  async update(id: string, update: UpgradeUpdate): Promise<Upgrade | null> {
    try {
      const row = await this.client.mutation(upgradeFunctions.update, {
        serviceToken: this.serviceToken,
        id,
        ...(update.buildId === undefined ? {} : { buildId: update.buildId }),
        ...(update.title === undefined ? {} : { title: update.title }),
        ...nullableArg("reason", update.reason),
        ...nullableArg("beforeState", update.beforeState),
        ...nullableArg("afterState", update.afterState),
        ...nullableArg("outcome", update.outcome),
        ...nullableArg("version", update.version),
        ...nullableArg("occurredAt", update.occurredAt),
        ...partsArg(update.parts),
      });
      return row === null ? null : upgradeFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }

  async remove(id: string): Promise<Upgrade | null> {
    try {
      const row = await this.client.mutation(upgradeFunctions.remove, {
        serviceToken: this.serviceToken,
        id,
      });
      return row === null ? null : upgradeFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }
}

/**
 * Translates a nullable scalar update field into Convex args: undefined omits it,
 * null becomes a `clear<Field>` flag, and a value is passed through.
 */
function nullableArg(
  field: "reason" | "beforeState" | "afterState" | "outcome" | "version" | "occurredAt",
  value: string | number | null | undefined,
): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  const clearKey = `clear${field.charAt(0).toUpperCase()}${field.slice(1)}`;
  return value === null ? { [clearKey]: true } : { [field]: value };
}

/**
 * Translates the nullable parts array: undefined omits it, null becomes the
 * `clearParts` flag, and an array is passed through.
 */
function partsArg(value: string[] | null | undefined): Record<string, string[] | boolean> {
  if (value === undefined) return {};
  return value === null ? { clearParts: true } : { parts: value };
}
