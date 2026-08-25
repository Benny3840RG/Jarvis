import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import {
  isProjectStatus,
  type Project,
  type ProjectInput,
  type ProjectStatus,
  type ProjectStore,
  type ProjectUpdate,
} from "./project.js";

const DOCUMENT_VERSION = 1 as const;

type ProjectDocument = { version: number; projects: Project[] };

function defaultProjectsPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-projects.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeProject(value: unknown): Project | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.clientId !== "string" ||
    typeof value.title !== "string"
  ) {
    return null;
  }
  const status: ProjectStatus = isProjectStatus(value.status) ? value.status : "lead";
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  return {
    id: value.id,
    clientId: value.clientId,
    ...(optionalText(value.propertyId) === undefined
      ? {}
      : { propertyId: optionalText(value.propertyId) }),
    title: value.title,
    status,
    ...(typeof value.notes === "string" && value.notes.trim() ? { notes: value.notes } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
  };
}

function cloneProject(project: Project): Project {
  return { ...project };
}

export class JsonProjectStore implements ProjectStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultProjectsPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<ProjectDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { version: DOCUMENT_VERSION, projects: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.setAside();
      return { version: DOCUMENT_VERSION, projects: [] };
    }
    const projectsValue = isRecord(parsed) ? parsed.projects : undefined;
    const rows = Array.isArray(projectsValue) ? projectsValue : [];
    const projects: Project[] = [];
    for (const row of rows) {
      const project = normalizeProject(row);
      if (project) projects.push(project);
    }
    return { version: DOCUMENT_VERSION, projects };
  }

  private async setAside(): Promise<void> {
    const corruptPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    try {
      await fs.rename(this.filePath, corruptPath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }

  private async writeDocument(document: ProjectDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.tmp-${process.pid}-${randomUUID()}`,
    );
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, this.filePath);
  }

  async list(): Promise<Project[]> {
    return (await this.readDocument()).projects.map(cloneProject);
  }

  async get(id: string): Promise<Project | null> {
    const project = (await this.readDocument()).projects.find((candidate) => candidate.id === id);
    return project ? cloneProject(project) : null;
  }

  async add(input: ProjectInput): Promise<Project> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const now = Date.now();
      const project: Project = {
        id: randomUUID(),
        clientId: requiredText(input.clientId, "Project clientId"),
        ...(optionalText(input.propertyId) === undefined
          ? {}
          : { propertyId: optionalText(input.propertyId) }),
        title: requiredText(input.title, "Project title"),
        status: input.status ?? "lead",
        ...(input.notes && input.notes.trim() ? { notes: input.notes.trim() } : {}),
        createdAt: now,
        updatedAt: now,
      };
      document.projects.push(project);
      await this.writeDocument(document);
      return cloneProject(project);
    }, "project mutation");
  }

  async update(id: string, update: ProjectUpdate): Promise<Project | null> {
    if (
      update.clientId === undefined &&
      update.propertyId === undefined &&
      update.title === undefined &&
      update.status === undefined &&
      update.notes === undefined
    ) {
      throw new Error(
        "Project update requires a clientId, propertyId, title, status, or notes change.",
      );
    }
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const project = document.projects.find((candidate) => candidate.id === id);
      if (!project) return null;
      if (update.clientId !== undefined)
        project.clientId = requiredText(update.clientId, "Project clientId");
      if (update.propertyId !== undefined) {
        const cleaned = update.propertyId === null ? "" : update.propertyId.trim();
        if (cleaned) project.propertyId = cleaned;
        else delete project.propertyId;
      }
      if (update.title !== undefined) project.title = requiredText(update.title, "Project title");
      if (update.status !== undefined) project.status = update.status;
      if (update.notes !== undefined) {
        const cleaned = update.notes === null ? "" : update.notes.trim();
        if (cleaned) project.notes = cleaned;
        else delete project.notes;
      }
      project.updatedAt = Date.now();
      await this.writeDocument(document);
      return cloneProject(project);
    }, "project mutation");
  }

  async remove(id: string): Promise<Project | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const index = document.projects.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.projects.splice(index, 1);
      await this.writeDocument(document);
      return cloneProject(removed);
    }, "project mutation");
  }
}
