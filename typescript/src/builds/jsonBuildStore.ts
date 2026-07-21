import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import { applyBuildUpdate, cloneBuild, createBuild } from "./buildData.js";
import {
  isBuildStatus,
  type Build,
  type BuildInput,
  type BuildStatus,
  type BuildStore,
  type BuildUpdate,
} from "./build.js";

const DOCUMENT_VERSION = 1 as const;

type BuildDocument = { version: number; builds: Build[] };

function defaultBuildsPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-builds.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBuild(value: unknown): Build | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.kind !== "string"
  )
    return null;
  const status: BuildStatus = isBuildStatus(value.status) ? value.status : "planning";
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    status,
    ...(typeof value.description === "string" && value.description.trim()
      ? { description: value.description }
      : {}),
    ...(typeof value.nickname === "string" && value.nickname.trim()
      ? { nickname: value.nickname }
      : {}),
    ...(typeof value.notes === "string" && value.notes.trim() ? { notes: value.notes } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
  };
}

export class JsonBuildStore implements BuildStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultBuildsPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<BuildDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { version: DOCUMENT_VERSION, builds: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.setAside();
      return { version: DOCUMENT_VERSION, builds: [] };
    }
    const buildsValue = isRecord(parsed) ? parsed.builds : undefined;
    const rows = Array.isArray(buildsValue) ? buildsValue : [];
    const builds: Build[] = [];
    for (const row of rows) {
      const build = normalizeBuild(row);
      if (build) builds.push(build);
    }
    return { version: DOCUMENT_VERSION, builds };
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

  private async writeDocument(document: BuildDocument): Promise<void> {
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

  async list(): Promise<Build[]> {
    return (await this.readDocument()).builds.map(cloneBuild);
  }

  async get(id: string): Promise<Build | null> {
    const build = (await this.readDocument()).builds.find((candidate) => candidate.id === id);
    return build ? cloneBuild(build) : null;
  }

  async add(input: BuildInput): Promise<Build> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const build = createBuild(input);
      document.builds.push(build);
      await this.writeDocument(document);
      return cloneBuild(build);
    }, "build mutation");
  }

  async update(id: string, update: BuildUpdate): Promise<Build | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const build = document.builds.find((candidate) => candidate.id === id);
      if (!build) return null;
      applyBuildUpdate(build, update);
      await this.writeDocument(document);
      return cloneBuild(build);
    }, "build mutation");
  }

  async remove(id: string): Promise<Build | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const index = document.builds.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.builds.splice(index, 1);
      await this.writeDocument(document);
      return cloneBuild(removed);
    }, "build mutation");
  }
}
