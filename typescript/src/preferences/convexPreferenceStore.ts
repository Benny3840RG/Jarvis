import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import { isInvalidIdError, type ConvexClientLike } from "../persistence/convexPersistence.js";
import type {
  Preference,
  PreferenceInput,
  PreferenceStore,
  PreferenceUpdate,
} from "./preference.js";

export const preferenceFunctions = api.preferences;

type PreferenceRow = {
  _id: string;
  key: string;
  value: string;
  category?: string;
  createdAt: number;
  updatedAt: number;
};

function preferenceFromConvex(row: PreferenceRow): Preference {
  return {
    id: row._id,
    key: row.key,
    value: row.value,
    ...(row.category === undefined ? {} : { category: row.category }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Convex-backed PreferenceStore. Selected when PERSISTENCE_PROVIDER=convex, so
 * Benny's standing choices live in the same durable deployment as the rest of
 * his memory and follow him across machines. Owner-scoped and authenticated by
 * the shared service token.
 */
export class ConvexPreferenceStore implements PreferenceStore {
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

  async list(): Promise<Preference[]> {
    const rows = await this.client.query(preferenceFunctions.list, {
      serviceToken: this.serviceToken,
    });
    return rows.map(preferenceFromConvex);
  }

  async get(id: string): Promise<Preference | null> {
    const row = await this.client.query(preferenceFunctions.get, {
      serviceToken: this.serviceToken,
      id,
    });
    return row === null ? null : preferenceFromConvex(row);
  }

  async add(input: PreferenceInput): Promise<Preference> {
    const row = await this.client.mutation(preferenceFunctions.create, {
      serviceToken: this.serviceToken,
      key: input.key,
      value: input.value,
      ...(input.category === undefined ? {} : { category: input.category }),
    });
    return preferenceFromConvex(row);
  }

  async update(id: string, update: PreferenceUpdate): Promise<Preference | null> {
    try {
      const row = await this.client.mutation(preferenceFunctions.update, {
        serviceToken: this.serviceToken,
        id,
        ...(update.key === undefined ? {} : { key: update.key }),
        ...(update.value === undefined ? {} : { value: update.value }),
        ...nullableArg("category", update.category),
      });
      return row === null ? null : preferenceFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }

  async remove(id: string): Promise<Preference | null> {
    try {
      const row = await this.client.mutation(preferenceFunctions.remove, {
        serviceToken: this.serviceToken,
        id,
      });
      return row === null ? null : preferenceFromConvex(row);
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
  field: "category",
  value: string | null | undefined,
): Record<string, string | boolean> {
  if (value === undefined) return {};
  const clearKey = `clear${field.charAt(0).toUpperCase()}${field.slice(1)}`;
  return value === null ? { [clearKey]: true } : { [field]: value };
}
