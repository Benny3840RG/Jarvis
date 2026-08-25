import type { BusinessSettingsUpdate } from "../businessSettings/businessSettings.js";
import {
  normalizeBps,
  normalizeCents,
  normalizePrefix,
  normalizeSequence,
  requiredText,
} from "../businessSettings/businessSettingsValidation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null.`);
  return requiredText(value, field);
}

function parseContactDetails(
  value: unknown,
): NonNullable<BusinessSettingsUpdate["contactDetails"]> {
  if (!isRecord(value)) throw new Error("Business contactDetails must be an object.");
  rejectUnknownKeys(value, ["phone", "email", "website", "abn"]);
  const update: NonNullable<BusinessSettingsUpdate["contactDetails"]> = {};
  if (value.phone !== undefined) update.phone = nullableText(value.phone, "Business phone");
  if (value.email !== undefined) update.email = nullableText(value.email, "Business email");
  if (value.website !== undefined) update.website = nullableText(value.website, "Business website");
  if (value.abn !== undefined) update.abn = nullableText(value.abn, "Business ABN");
  return update;
}

function parsePaymentDetails(
  value: unknown,
): NonNullable<BusinessSettingsUpdate["paymentDetails"]> {
  if (!isRecord(value)) throw new Error("Business paymentDetails must be an object.");
  rejectUnknownKeys(value, [
    "bankName",
    "accountName",
    "bsb",
    "accountNumber",
    "paymentReferenceTemplate",
  ]);
  const update: NonNullable<BusinessSettingsUpdate["paymentDetails"]> = {};
  if (value.bankName !== undefined) update.bankName = nullableText(value.bankName, "Bank name");
  if (value.accountName !== undefined)
    update.accountName = nullableText(value.accountName, "Account name");
  if (value.bsb !== undefined) update.bsb = nullableText(value.bsb, "BSB");
  if (value.accountNumber !== undefined)
    update.accountNumber = nullableText(value.accountNumber, "Account number");
  if (value.paymentReferenceTemplate !== undefined) {
    update.paymentReferenceTemplate = nullableText(
      value.paymentReferenceTemplate,
      "Payment reference template",
    );
  }
  return update;
}

function parsePricing(value: unknown): NonNullable<BusinessSettingsUpdate["pricing"]> {
  if (!isRecord(value)) throw new Error("Business pricing must be an object.");
  rejectUnknownKeys(value, [
    "defaultLabourRateCents",
    "defaultTravelRateCents",
    "defaultEquipmentRateCents",
    "defaultWasteRateCents",
    "defaultMaterialsMarkupBps",
    "defaultMarginBps",
    "gstRateBps",
  ]);
  const update: NonNullable<BusinessSettingsUpdate["pricing"]> = {};
  if (value.defaultLabourRateCents !== undefined)
    update.defaultLabourRateCents = normalizeCents(
      value.defaultLabourRateCents,
      "Default labour rate",
    );
  if (value.defaultTravelRateCents !== undefined)
    update.defaultTravelRateCents = normalizeCents(
      value.defaultTravelRateCents,
      "Default travel rate",
    );
  if (value.defaultEquipmentRateCents !== undefined)
    update.defaultEquipmentRateCents = normalizeCents(
      value.defaultEquipmentRateCents,
      "Default equipment rate",
    );
  if (value.defaultWasteRateCents !== undefined)
    update.defaultWasteRateCents = normalizeCents(
      value.defaultWasteRateCents,
      "Default waste rate",
    );
  if (value.defaultMaterialsMarkupBps !== undefined)
    update.defaultMaterialsMarkupBps = normalizeBps(
      value.defaultMaterialsMarkupBps,
      "Default materials markup",
    );
  if (value.defaultMarginBps !== undefined)
    update.defaultMarginBps = normalizeBps(value.defaultMarginBps, "Default margin");
  if (value.gstRateBps !== undefined)
    update.gstRateBps = normalizeBps(value.gstRateBps, "GST rate");
  return update;
}

function parseNumbering(value: unknown): NonNullable<BusinessSettingsUpdate["numbering"]> {
  if (!isRecord(value)) throw new Error("Business numbering must be an object.");
  rejectUnknownKeys(value, [
    "quotePrefix",
    "nextQuoteNumber",
    "invoicePrefix",
    "nextInvoiceNumber",
  ]);
  const update: NonNullable<BusinessSettingsUpdate["numbering"]> = {};
  if (value.quotePrefix !== undefined)
    update.quotePrefix = normalizePrefix(value.quotePrefix, "Quote prefix");
  if (value.nextQuoteNumber !== undefined)
    update.nextQuoteNumber = normalizeSequence(value.nextQuoteNumber, "Next quote number");
  if (value.invoicePrefix !== undefined)
    update.invoicePrefix = normalizePrefix(value.invoicePrefix, "Invoice prefix");
  if (value.nextInvoiceNumber !== undefined)
    update.nextInvoiceNumber = normalizeSequence(value.nextInvoiceNumber, "Next invoice number");
  return update;
}

export function parseUpdateBusinessSettings(body: unknown): BusinessSettingsUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, [
    "businessName",
    "tradingName",
    "gstRegistered",
    "contactDetails",
    "paymentDetails",
    "pricing",
    "numbering",
  ]);
  if (Object.keys(body).length === 0) {
    throw new Error("Business settings update requires at least one changed field.");
  }
  const update: BusinessSettingsUpdate = {};
  if (body.businessName !== undefined) {
    if (typeof body.businessName !== "string") throw new Error("Business name must be a string.");
    update.businessName = requiredText(body.businessName, "Business name");
  }
  if (body.tradingName !== undefined) {
    if (typeof body.tradingName !== "string") throw new Error("Trading name must be a string.");
    update.tradingName = requiredText(body.tradingName, "Trading name");
  }
  if (body.gstRegistered !== undefined) {
    if (typeof body.gstRegistered !== "boolean") {
      throw new Error("Business gstRegistered must be a boolean.");
    }
    update.gstRegistered = body.gstRegistered;
  }
  if (body.contactDetails !== undefined)
    update.contactDetails = parseContactDetails(body.contactDetails);
  if (body.paymentDetails !== undefined)
    update.paymentDetails = parsePaymentDetails(body.paymentDetails);
  if (body.pricing !== undefined) update.pricing = parsePricing(body.pricing);
  if (body.numbering !== undefined) update.numbering = parseNumbering(body.numbering);
  return update;
}
