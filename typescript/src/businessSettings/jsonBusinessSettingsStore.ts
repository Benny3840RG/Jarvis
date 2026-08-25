import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import type {
  BusinessSettings,
  BusinessSettingsStore,
  BusinessSettingsUpdate,
} from "./businessSettings.js";
import { defaultBusinessSettings } from "./businessSettings.js";
import { applySettingsUpdate, normalizeSettings } from "./businessSettingsValidation.js";

const DOCUMENT_VERSION = 1 as const;

type BusinessSettingsDocument = { version: number; settings: BusinessSettings };

function defaultSettingsPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-business-settings.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function clone(settings: BusinessSettings): BusinessSettings {
  return {
    ...settings,
    contactDetails: { ...settings.contactDetails },
    paymentDetails: { ...settings.paymentDetails },
    pricing: { ...settings.pricing },
    numbering: { ...settings.numbering },
  };
}

export class JsonBusinessSettingsStore implements BusinessSettingsStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultSettingsPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<BusinessSettingsDocument> {
    const fallback = defaultBusinessSettings();
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: DOCUMENT_VERSION, settings: fallback };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.setAside();
      return { version: DOCUMENT_VERSION, settings: fallback };
    }
    const settings =
      typeof parsed === "object" && parsed !== null && "settings" in parsed
        ? (parsed as { settings: unknown }).settings
        : parsed;
    return { version: DOCUMENT_VERSION, settings: normalizeSettings(settings, fallback) };
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

  private async writeDocument(document: BusinessSettingsDocument): Promise<void> {
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

  async get(): Promise<BusinessSettings> {
    return clone((await this.readDocument()).settings);
  }

  async update(update: BusinessSettingsUpdate): Promise<BusinessSettings> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const settings = applySettingsUpdate(document.settings, update);
      await this.writeDocument({ version: DOCUMENT_VERSION, settings });
      return clone(settings);
    }, "business settings mutation");
  }
}
