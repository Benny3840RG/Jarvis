import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type {
  CreateNoteInput,
  NoteDomain,
  NoteRecord,
  NoteRetention,
  NoteSensitivity,
  NoteStore,
} from "../notes/note.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const noteFunctions = api.notes;

type NoteRow = {
  _id: string;
  projectId: string;
  title: string;
  body: string;
  tags: string[];
  domain: NoteDomain;
  sensitivity: NoteSensitivity;
  retention: NoteRetention;
  sourceRequestId: string;
  correlationId: string;
  source: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

function noteFromConvex(row: NoteRow): NoteRecord {
  return {
    id: row._id,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    tags: [...row.tags],
    domain: row.domain,
    sensitivity: row.sensitivity,
    retention: row.retention,
    sourceRequestId: row.sourceRequestId,
    correlationId: row.correlationId,
    source: row.source,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ConvexNoteStore implements NoteStore {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) throw new Error("Notes require JARVIS_SERVICE_TOKEN.");
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Notes require CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async create(input: CreateNoteInput): Promise<NoteRecord> {
    const row = await this.client.mutation(noteFunctions.create, {
      serviceToken: this.serviceToken,
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      tags: input.tags,
      domain: input.domain,
      sensitivity: input.sensitivity,
      retention: input.retention,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
      sourceRequestId: input.sourceRequestId,
      correlationId: input.correlationId,
      source: input.source,
    });
    return noteFromConvex(row as NoteRow);
  }

  async get(projectId: string, id: string): Promise<NoteRecord | null> {
    const row = await this.client.query(noteFunctions.get, {
      serviceToken: this.serviceToken,
      projectId,
      id,
    });
    return row === null ? null : noteFromConvex(row as NoteRow);
  }

  async list(projectId: string, limit?: number): Promise<NoteRecord[]> {
    const rows = await this.client.query(noteFunctions.list, {
      serviceToken: this.serviceToken,
      projectId,
      ...(limit === undefined ? {} : { limit }),
    });
    return (rows as NoteRow[]).map(noteFromConvex);
  }
}
