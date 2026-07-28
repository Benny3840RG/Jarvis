import { createHash } from "node:crypto";

import type { QuoteSnapshot } from "./quoteLifecycle.js";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const FINGERPRINT_PATTERN = /^quote-revision:v1:sha256:[a-f0-9]{64}$/;
const WINDOWS_1252: Readonly<Record<string, number>> = {
  "€": 0x80,
  "‚": 0x82,
  "ƒ": 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  "ˆ": 0x88,
  "‰": 0x89,
  "Š": 0x8a,
  "‹": 0x8b,
  "Œ": 0x8c,
  "Ž": 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "˜": 0x98,
  "™": 0x99,
  "š": 0x9a,
  "›": 0x9b,
  "œ": 0x9c,
  "ž": 0x9e,
  "Ÿ": 0x9f,
};

export type QuotePdfParty = {
  name: string;
  abn?: string;
  email?: string;
  phone?: string;
  addressLines?: string[];
};

export type QuotePdfRenderInput = {
  snapshot: QuoteSnapshot;
  issuer: QuotePdfParty;
  client: QuotePdfParty;
  generatedAt: string;
};

export type QuotePdfArtifact = {
  bytes: Uint8Array;
  byteLength: number;
  digest: string;
  filename: string;
  mediaType: "application/pdf";
};

export class QuotePdfError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QuotePdfError";
  }
}

type FontName = "F1" | "F2";
type Page = { commands: string[] };

function fail(code: string): never {
  throw new QuotePdfError(code);
}

function money(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(value);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function windows1252Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code === 0 || code < 32 || code === 127) {
      fail("quote-pdf-content-invalid");
    }
    if (code <= 0x7e || (code >= 0xa0 && code <= 0xff)) {
      bytes.push(code);
      continue;
    }
    const mapped = WINDOWS_1252[character];
    if (mapped === undefined) fail("quote-pdf-content-invalid");
    bytes.push(mapped);
  }
  return Uint8Array.from(bytes);
}

function textHex(value: string): string {
  return `<${Buffer.from(windows1252Bytes(value)).toString("hex").toUpperCase()}>`;
}

function validateText(value: string | undefined, max: number, required = false): void {
  if (value === undefined) {
    if (required) fail("quote-pdf-party-invalid");
    return;
  }
  if ((required && !value.trim()) || value.length > max) fail("quote-pdf-party-invalid");
  windows1252Bytes(value);
}

function validateParty(party: QuotePdfParty): void {
  validateText(party.name, 120, true);
  validateText(party.abn, 40);
  validateText(party.email, 320);
  validateText(party.phone, 60);
  if ((party.addressLines?.length ?? 0) > 8) fail("quote-pdf-limit-exceeded");
  for (const line of party.addressLines ?? []) validateText(line, 160);
}

function validateSnapshot(snapshot: QuoteSnapshot): void {
  const { aggregate, revision } = snapshot;
  if (revision.status !== "finalized") fail("quote-pdf-not-finalized");
  if (!revision.fingerprint || !FINGERPRINT_PATTERN.test(revision.fingerprint)) {
    fail("quote-pdf-fingerprint-invalid");
  }
  if (
    aggregate.quoteId !== revision.quoteId ||
    aggregate.ownerId !== revision.ownerId ||
    aggregate.currentRevision !== revision.revision ||
    aggregate.currentRevisionId !== revision.revisionId
  ) {
    fail("quote-pdf-identity-mismatch");
  }
  if (revision.lineItems.length > 200) fail("quote-pdf-limit-exceeded");
  let subtotal = 0;
  for (const item of revision.lineItems) {
    if (!item.description.trim() || item.description.length > 160) {
      fail("quote-pdf-content-invalid");
    }
    windows1252Bytes(item.description);
    if (
      !Number.isFinite(item.quantity) ||
      item.quantity < 0 ||
      !Number.isFinite(item.unitPrice) ||
      item.unitPrice < 0
    ) {
      fail("quote-pdf-totals-invalid");
    }
    subtotal += item.quantity * item.unitPrice;
  }
  const taxRate = revision.taxRate ?? 0;
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
    fail("quote-pdf-totals-invalid");
  }
  const expectedSubtotal = roundMoney(subtotal);
  const expectedTax = roundMoney(expectedSubtotal * taxRate);
  if (
    !Number.isFinite(revision.subtotal) ||
    !Number.isFinite(revision.tax) ||
    !Number.isFinite(revision.total) ||
    revision.subtotal !== expectedSubtotal ||
    revision.tax !== expectedTax ||
    revision.total !== roundMoney(expectedSubtotal + expectedTax)
  ) {
    fail("quote-pdf-totals-invalid");
  }
  validateText(aggregate.number, 120, true);
  validateText(revision.validUntil, 40);
  if ((revision.notes?.length ?? 0) > 2_000) fail("quote-pdf-limit-exceeded");
  if (revision.notes !== undefined) windows1252Bytes(revision.notes);
}

function wrap(value: string, maxCharacters: number): string[] {
  const paragraphs = value.split(/\r?\n/u);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      if (word.length > maxCharacters) {
        if (current) {
          lines.push(current);
          current = "";
        }
        for (let offset = 0; offset < word.length; offset += maxCharacters) {
          lines.push(word.slice(offset, offset + maxCharacters));
        }
        continue;
      }
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxCharacters) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function drawText(
  page: Page,
  value: string,
  x: number,
  y: number,
  size = 10,
  font: FontName = "F1",
): void {
  page.commands.push(
    `BT /${font} ${size.toFixed(2)} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(
      2,
    )} Tm ${textHex(value)} Tj ET`,
  );
}

function drawLine(page: Page, x1: number, y1: number, x2: number, y2: number): void {
  page.commands.push(
    `0.12 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
  );
}

function partyLines(party: QuotePdfParty): string[] {
  return [
    party.name,
    ...(party.abn ? [`ABN ${party.abn}`] : []),
    ...(party.addressLines ?? []),
    ...(party.email ? [party.email] : []),
    ...(party.phone ? [party.phone] : []),
  ];
}

function safeFilenameToken(value: string): string {
  const token = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return token || "Quote";
}

function pdfDate(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== iso) {
    fail("quote-pdf-content-invalid");
  }
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function buildPages(input: QuotePdfRenderInput): Page[] {
  const { snapshot } = input;
  const { aggregate, revision } = snapshot;
  const pages: Page[] = [];
  let page: Page;
  let y = 0;

  const startPage = (): void => {
    page = { commands: ["0 0 0 rg", "0 0 0 RG"] };
    pages.push(page);
    drawText(page, input.issuer.name, 48, 792, 18, "F2");
    drawText(page, `QUOTE ${aggregate.number}`, 385, 792, 14, "F2");
    drawText(page, `Revision ${revision.revision}`, 446, 774, 9);
    drawLine(page, 48, 758, 547, 758);
    drawText(page, "Description", 48, 735, 9, "F2");
    drawText(page, "Qty", 350, 735, 9, "F2");
    drawText(page, "Unit", 405, 735, 9, "F2");
    drawText(page, "Amount", 485, 735, 9, "F2");
    drawLine(page, 48, 728, 547, 728);
    y = 711;
  };

  const ensure = (height: number): void => {
    if (y - height < 105) startPage();
  };

  startPage();

  const issuer = partyLines(input.issuer);
  const client = partyLines(input.client);
  const partyHeight = Math.max(issuer.length, client.length) * 12 + 30;
  ensure(partyHeight);
  drawText(page!, "FROM", 48, y, 8, "F2");
  drawText(page!, "PREPARED FOR", 300, y, 8, "F2");
  let partyY = y - 16;
  for (let index = 0; index < Math.max(issuer.length, client.length); index += 1) {
    if (issuer[index]) drawText(page!, issuer[index]!, 48, partyY, 9);
    if (client[index]) drawText(page!, client[index]!, 300, partyY, 9);
    partyY -= 12;
  }
  y -= partyHeight;
  drawText(
    page!,
    `Finalized: ${new Date(revision.finalizedAt ?? revision.updatedAt).toISOString().slice(0, 10)}`,
    48,
    y,
    9,
  );
  if (revision.validUntil) drawText(page!, `Valid until: ${revision.validUntil}`, 300, y, 9);
  y -= 24;
  drawLine(page!, 48, y + 8, 547, y + 8);

  for (const item of revision.lineItems) {
    const descriptionLines = wrap(item.description, 52);
    const rowHeight = Math.max(18, descriptionLines.length * 12 + 6);
    ensure(rowHeight);
    for (let index = 0; index < descriptionLines.length; index += 1) {
      drawText(page!, descriptionLines[index]!, 48, y - index * 12, 9);
    }
    drawText(page!, String(item.quantity), 350, y, 9);
    drawText(page!, money(item.unitPrice), 405, y, 9);
    drawText(page!, money(roundMoney(item.quantity * item.unitPrice)), 485, y, 9);
    y -= rowHeight;
    drawLine(page!, 48, y + 5, 547, y + 5);
  }

  ensure(90);
  y -= 8;
  drawText(page!, "Subtotal", 405, y, 9);
  drawText(page!, money(revision.subtotal), 485, y, 9);
  y -= 16;
  drawText(page!, `GST (${((revision.taxRate ?? 0) * 100).toFixed(0)}%)`, 405, y, 9);
  drawText(page!, money(revision.tax), 485, y, 9);
  y -= 20;
  drawLine(page!, 400, y + 8, 547, y + 8);
  drawText(page!, "TOTAL AUD", 405, y - 6, 11, "F2");
  drawText(page!, money(revision.total), 485, y - 6, 11, "F2");
  y -= 38;

  if (revision.notes) {
    const noteLines = wrap(revision.notes, 82);
    ensure(noteLines.length * 12 + 28);
    drawText(page!, "NOTES", 48, y, 9, "F2");
    y -= 16;
    for (const line of noteLines) {
      ensure(14);
      drawText(page!, line, 48, y, 9);
      y -= 12;
    }
    y -= 8;
  }

  if (revision.termsIncluded) {
    ensure(30);
    drawText(page!, "Terms and conditions form part of this quote.", 48, y, 8);
  }

  return pages;
}

function serializePdf(pages: Page[], input: QuotePdfRenderInput): Uint8Array {
  const fingerprint = input.snapshot.revision.fingerprint!;
  const pageCount = pages.length;
  const objects: string[] = [];
  const pageObjectIds = pages.map((_, index) => 5 + index * 2);
  const contentObjectIds = pages.map((_, index) => 6 + index * 2);
  const infoObjectId = 5 + pages.length * 2;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const pageNumber = index + 1;
    page.commands.push(`% ${fingerprint}`);
    page.commands.push(`% Page ${pageNumber} of ${pageCount}`);
    drawLine(page, 48, 82, 547, 82);
    drawText(page, fingerprint, 48, 64, 6);
    drawText(page, `Page ${pageNumber} of ${pageCount}`, 480, 50, 7);
    const stream = `${page.commands.join("\n")}\n`;
    objects[pageObjectIds[index]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH} ${A4_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`;
    objects[contentObjectIds[index]!] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;
  }

  objects[infoObjectId] =
    `<< /Title ${textHex(`Quote ${input.snapshot.aggregate.number}`)} /Author ${textHex(
      input.issuer.name,
    )} /Creator ${textHex("Jarvis")} /Producer ${textHex(
      "Jarvis deterministic quote PDF v1",
    )} /CreationDate ${textHex(pdfDate(input.generatedAt))} >>`;

  const chunks: string[] = ["%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"];
  const offsets = [0];
  let offset = Buffer.byteLength(chunks[0]!, "latin1");
  for (let id = 1; id <= infoObjectId; id += 1) {
    const object = `${id} 0 obj\n${objects[id]}\nendobj\n`;
    offsets[id] = offset;
    chunks.push(object);
    offset += Buffer.byteLength(object, "latin1");
  }
  const xrefOffset = offset;
  chunks.push(`xref\n0 ${infoObjectId + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  for (let id = 1; id <= infoObjectId; id += 1) {
    chunks.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  const documentId = fingerprint.slice(-64, -32).toUpperCase();
  chunks.push(
    `trailer\n<< /Size ${infoObjectId + 1} /Root 1 0 R /Info ${infoObjectId} 0 R /ID [<${documentId}><${documentId}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
  return Uint8Array.from(Buffer.from(chunks.join(""), "latin1"));
}

export function renderFinalizedQuotePdf(input: QuotePdfRenderInput): QuotePdfArtifact {
  validateSnapshot(input.snapshot);
  validateParty(input.issuer);
  validateParty(input.client);
  pdfDate(input.generatedAt);
  const pages = buildPages(input);
  const bytes = serializePdf(pages, input);
  if (bytes.byteLength > MAX_OUTPUT_BYTES) fail("quote-pdf-output-too-large");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    byteLength: bytes.byteLength,
    digest: `quote-pdf:v1:sha256:${digest}`,
    filename: `Quote-${safeFilenameToken(input.snapshot.aggregate.number)}-R${input.snapshot.revision.revision}.pdf`,
    mediaType: "application/pdf",
  };
}
