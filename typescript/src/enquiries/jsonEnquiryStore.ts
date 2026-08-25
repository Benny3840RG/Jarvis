import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import type { ProjectStore } from "../projects/project.js";
import type {
  Enquiry,
  EnquiryConversionInput,
  EnquiryConversionResult,
  EnquiryInput,
  EnquiryStatus,
  EnquiryStore,
  EnquiryUpdate,
} from "./enquiry.js";
import {
  applyEnquiryUpdate,
  cloneEnquiry,
  createEnquiry,
  normalizeEnquiry,
  requiredText,
} from "./enquiryData.js";

const DOCUMENT_VERSION = 1 as const;

type EnquiryDocument = { version: number; enquiries: Enquiry[] };

function defaultEnquiriesPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-enquiries.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class JsonEnquiryStore implements EnquiryStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultEnquiriesPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<EnquiryDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { version: DOCUMENT_VERSION, enquiries: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.setAside();
      return { version: DOCUMENT_VERSION, enquiries: [] };
    }
    const rows =
      typeof parsed === "object" &&
      parsed !== null &&
      "enquiries" in parsed &&
      Array.isArray((parsed as { enquiries: unknown }).enquiries)
        ? (parsed as { enquiries: unknown[] }).enquiries
        : [];
    const enquiries: Enquiry[] = [];
    for (const row of rows) {
      const enquiry = normalizeEnquiry(row);
      if (enquiry) enquiries.push(enquiry);
    }
    return { version: DOCUMENT_VERSION, enquiries };
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

  private async writeDocument(document: EnquiryDocument): Promise<void> {
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

  async list(filter: { status?: EnquiryStatus; clientId?: string } = {}): Promise<Enquiry[]> {
    return (await this.readDocument()).enquiries
      .filter((enquiry) => filter.status === undefined || enquiry.status === filter.status)
      .filter((enquiry) => filter.clientId === undefined || enquiry.clientId === filter.clientId)
      .map(cloneEnquiry);
  }

  async get(id: string): Promise<Enquiry | null> {
    const enquiry = (await this.readDocument()).enquiries.find((candidate) => candidate.id === id);
    return enquiry ? cloneEnquiry(enquiry) : null;
  }

  async add(input: EnquiryInput): Promise<Enquiry> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const duplicateKey = input.duplicateKey?.trim();
      if (duplicateKey) {
        const existing = document.enquiries.find(
          (enquiry) => enquiry.duplicateKey === duplicateKey,
        );
        if (existing) return cloneEnquiry(existing);
      }
      const enquiry = createEnquiry(input);
      document.enquiries.push(enquiry);
      await this.writeDocument(document);
      return cloneEnquiry(enquiry);
    }, "enquiry mutation");
  }

  async update(id: string, update: EnquiryUpdate): Promise<Enquiry | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const enquiry = document.enquiries.find((candidate) => candidate.id === id);
      if (!enquiry) return null;
      applyEnquiryUpdate(enquiry, update);
      await this.writeDocument(document);
      return cloneEnquiry(enquiry);
    }, "enquiry mutation");
  }

  async close(id: string, reason: string): Promise<Enquiry | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const enquiry = document.enquiries.find((candidate) => candidate.id === id);
      if (!enquiry) return null;
      if (enquiry.status !== "open") throw new Error("Only open enquiries can be closed.");
      enquiry.status = "closed";
      enquiry.closedReason = requiredText(reason, "Closed reason");
      enquiry.updatedAt = Date.now();
      await this.writeDocument(document);
      return cloneEnquiry(enquiry);
    }, "enquiry mutation");
  }

  async convertToProject(
    id: string,
    projects: ProjectStore,
    input: EnquiryConversionInput = {},
  ): Promise<EnquiryConversionResult | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const enquiry = document.enquiries.find((candidate) => candidate.id === id);
      if (!enquiry) return null;
      if (enquiry.status === "converted" && enquiry.convertedProjectId) {
        const project = await projects.get(enquiry.convertedProjectId);
        if (!project) throw new Error("Converted project is unavailable.");
        return { enquiry: cloneEnquiry(enquiry), project, replayed: true };
      }
      if (enquiry.status !== "open") throw new Error("Only open enquiries can be converted.");
      const project = await projects.add({
        clientId: enquiry.clientId,
        ...(enquiry.propertyId === undefined ? {} : { propertyId: enquiry.propertyId }),
        title: input.title?.trim() || enquiry.requestedWork,
        status: "lead",
        notes:
          input.notes?.trim() ||
          [
            `Converted from enquiry ${enquiry.id}.`,
            `Source: ${enquiry.source}.`,
            enquiry.safetyNotes ? `Safety/access: ${enquiry.safetyNotes}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
      });
      enquiry.status = "converted";
      enquiry.convertedProjectId = project.id;
      enquiry.updatedAt = Date.now();
      try {
        await this.writeDocument(document);
      } catch (error: unknown) {
        try {
          await projects.remove(project.id);
        } catch (rollbackError: unknown) {
          throw new AggregateError(
            [error, rollbackError],
            "Enquiry conversion persistence failed and compensating project rollback also failed.",
          );
        }
        throw error;
      }
      return { enquiry: cloneEnquiry(enquiry), project, replayed: false };
    }, "enquiry mutation");
  }
}
