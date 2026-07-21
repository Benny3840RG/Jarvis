import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import { isInvalidIdError, type ConvexClientLike } from "../persistence/convexPersistence.js";
import type { Build, BuildInput, BuildStore, BuildUpdate } from "./build.js";

export const buildFunctions = api.builds;

type BuildRow = {
  _id: string;
  name: string;
  kind: string;
  status: Build["status"];
  description?: string;
  nickname?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

function buildFromConvex(row: BuildRow): Build {
  return {
    id: row._id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.nickname === undefined ? {} : { nickname: row.nickname }),
    ...(row.notes === undefined ? {} : { notes: row.notes }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Convex-backed BuildStore. Selected when PERSISTENCE_PROVIDER=convex, so Benny's
 * builds live in the same durable Convex deployment as his tasks and reminders
 * and follow him across machines. Owner-scoped and authenticated by the same
 * service token as the rest of the Convex layer.
 */
export class ConvexBuildStore implements BuildStore {
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

  async list(): Promise<Build[]> {
    const rows = await this.client.query(buildFunctions.list, {
      serviceToken: this.serviceToken,
    });
    return rows.map(buildFromConvex);
  }

  async get(id: string): Promise<Build | null> {
    const row = await this.client.query(buildFunctions.get, {
      serviceToken: this.serviceToken,
      id,
    });
    return row === null ? null : buildFromConvex(row);
  }

  async add(input: BuildInput): Promise<Build> {
    const row = await this.client.mutation(buildFunctions.create, {
      serviceToken: this.serviceToken,
      name: input.name,
      kind: input.kind,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    });
    return buildFromConvex(row);
  }

  async update(id: string, update: BuildUpdate): Promise<Build | null> {
    try {
      const row = await this.client.mutation(buildFunctions.update, {
        serviceToken: this.serviceToken,
        id,
        ...(update.name === undefined ? {} : { name: update.name }),
        ...(update.kind === undefined ? {} : { kind: update.kind }),
        ...(update.status === undefined ? {} : { status: update.status }),
        ...nullableArg("description", update.description),
        ...nullableArg("nickname", update.nickname),
        ...nullableArg("notes", update.notes),
      });
      return row === null ? null : buildFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }

  async remove(id: string): Promise<Build | null> {
    try {
      const row = await this.client.mutation(buildFunctions.remove, {
        serviceToken: this.serviceToken,
        id,
      });
      return row === null ? null : buildFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }
}

/**
 * Translates a nullable update field into Convex args: undefined omits it, null
 * becomes a `clear<Field>` flag, and a string is passed through. Capitalises the
 * field for the clear flag (description -> clearDescription).
 */
function nullableArg(
  field: "description" | "nickname" | "notes",
  value: string | null | undefined,
): Record<string, string | boolean> {
  if (value === undefined) return {};
  const clearKey = `clear${field.charAt(0).toUpperCase()}${field.slice(1)}`;
  return value === null ? { [clearKey]: true } : { [field]: value };
}
