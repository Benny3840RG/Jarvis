/**
 * Development-only legacy quote migration CLI.
 *
 * Reads legacy quotes from the flat JSON QuoteStore
 * (typescript/data/jarvis-quotes.json) and imports each one into the Convex
 * revision-based quote model using the dev-only `quoteMigration.importLegacyQuote`
 * mutation.
 *
 * Safety boundaries:
 * - Refuses to run unless CONVEX_DEPLOYMENT starts with "dev:".
 * - Never modifies the source JSON file.
 * - Each row is idempotent: a second run skips already-imported quotes.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { loadEnvFile } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { LegacyQuoteRow } from "../../convex/quoteMigration.js";
import type { QuoteStatus } from "../quotes/quote.js";

const AUTHORISED_DEPLOYMENT = "dev:outgoing-ram-798";

export type MigrationSummary = {
  total: number;
  imported: number;
  skipped: number;
  rejected: number;
  errors: Array<{ legacyId: string; reason: string }>;
};

function loadLocalEnvironment(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, "../../.env.local");
  try {
    loadEnvFile(envPath);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function isLegacyQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === "string" && ["draft", "sent", "accepted", "declined"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLegacyQuote(value: unknown): LegacyQuoteRow | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.clientId !== "string" ||
    typeof value.number !== "string" ||
    !isLegacyQuoteStatus(value.status)
  ) {
    return null;
  }
  if (!Array.isArray(value.lineItems)) return null;

  const lineItems: Array<{ description: string; quantity: number; unitPrice: number }> = [];
  for (const item of value.lineItems) {
    if (
      !isRecord(item) ||
      typeof item.description !== "string" ||
      typeof item.quantity !== "number" ||
      typeof item.unitPrice !== "number"
    ) {
      return null;
    }
    lineItems.push({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    });
  }

  return {
    id: value.id as string,
    clientId: value.clientId as string,
    ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
    number: value.number as string,
    status: value.status as QuoteStatus,
    lineItems,
    ...(typeof value.taxRate === "number" ? { taxRate: value.taxRate } : {}),
    ...(typeof value.validUntil === "string" ? { validUntil: value.validUntil } : {}),
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  };
}

async function readLegacyQuotes(quotesPath: string): Promise<LegacyQuoteRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(quotesPath, "utf8");
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error(`Legacy quotes file is not valid JSON: ${quotesPath}`);
  }

  if (!isRecord(doc)) throw new Error("Legacy quotes document must be a JSON object.");
  if (!Array.isArray(doc.quotes))
    throw new Error("Legacy quotes document must have a 'quotes' array.");

  const rows: LegacyQuoteRow[] = [];
  for (const entry of doc.quotes as unknown[]) {
    const parsed = parseLegacyQuote(entry);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

export async function migrateLegacyQuotes(
  sourceFile: string,
  deployment: string | undefined,
  convexUrl: string | undefined,
  serviceToken: string | undefined,
  write: (message: string) => void = (message) => console.log(message),
): Promise<MigrationSummary> {
  if (!deployment?.trim().startsWith("dev:")) {
    throw new Error(
      "Legacy quote migration refused: CONVEX_DEPLOYMENT must identify a development deployment (dev:...).",
    );
  }
  if (deployment.trim() !== AUTHORISED_DEPLOYMENT) {
    throw new Error(
      `Legacy quote migration refused: authorised deployment is ${AUTHORISED_DEPLOYMENT}; got ${deployment}.`,
    );
  }
  if (!convexUrl) {
    throw new Error("Legacy quote migration refused: CONVEX_URL is not set.");
  }
  if (!serviceToken) {
    throw new Error("Legacy quote migration refused: JARVIS_SERVICE_TOKEN is not set.");
  }

  const rows = await readLegacyQuotes(sourceFile);
  write(`Found ${rows.length} legacy quote(s) in ${sourceFile}.`);

  const client = new ConvexHttpClient(convexUrl);
  const summary: MigrationSummary = {
    total: rows.length,
    imported: 0,
    skipped: 0,
    rejected: 0,
    errors: [],
  };

  for (const row of rows) {
    try {
      const result = await client.mutation(api.quoteMigration.importLegacyQuote, {
        serviceToken,
        legacyId: row.id,
        legacyRevisionId: randomUUID(),
        clientId: row.clientId,
        ...(row.projectId === undefined ? {} : { projectId: row.projectId }),
        number: row.number,
        status: row.status,
        lineItems: row.lineItems,
        ...(row.taxRate === undefined ? {} : { taxRate: row.taxRate }),
        ...(row.validUntil === undefined ? {} : { validUntil: row.validUntil }),
        ...(row.notes === undefined ? {} : { notes: row.notes }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });

      if (result.skipped) {
        summary.skipped++;
        write(`  SKIP   ${row.id} (${row.number}) – already imported as quoteId ${result.quoteId}`);
      } else {
        summary.imported++;
        write(
          `  OK     ${row.id} (${row.number}) → quoteId ${result.quoteId}, status ${result.mappedStatus}`,
        );
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      summary.rejected++;
      summary.errors.push({ legacyId: row.id, reason });
      write(`  ERROR  ${row.id} (${row.number}): ${reason}`);
    }
  }

  write(
    `Migration complete: ${summary.imported} imported, ${summary.skipped} skipped, ${summary.rejected} rejected of ${summary.total} total.`,
  );
  return summary;
}

async function main(): Promise<void> {
  loadLocalEnvironment();

  const here = path.dirname(fileURLToPath(import.meta.url));
  const defaultSource = path.resolve(here, "../../data/jarvis-quotes.json");
  const sourceFile = process.argv[2] ?? defaultSource;

  await migrateLegacyQuotes(
    sourceFile,
    process.env.CONVEX_DEPLOYMENT,
    process.env.CONVEX_URL,
    process.env.JARVIS_SERVICE_TOKEN,
  );
}

main().catch((error: unknown) => {
  console.error(
    "Legacy quote migration failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
