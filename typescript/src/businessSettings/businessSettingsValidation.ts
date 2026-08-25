import type {
  BusinessContactDetails,
  BusinessNumberingSettings,
  BusinessPaymentDetails,
  BusinessPricingSettings,
  BusinessSettings,
  BusinessSettingsUpdate,
} from "./businessSettings.js";

const MAX_TEXT_LENGTH = 500;
const MAX_PREFIX_LENGTH = 20;
const MAX_RATE_CENTS = 10_000_000;
const MAX_BPS = 10_000;
const MAX_SEQUENCE = 999_999_999;

const SECRET_PATTERNS = [
  /api[_ -]?key/i,
  /bearer\s+[a-z0-9._-]+/i,
  /client[_ -]?secret/i,
  /password/i,
  /refresh[_ -]?token/i,
  /access[_ -]?token/i,
  /sk-[a-z0-9_-]{12,}/i,
];

export function assertNoSecretText(value: string, field: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${field} must not contain credentials, tokens, or secrets.`);
  }
}

export function requiredText(value: string, field: string, max = MAX_TEXT_LENGTH): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  if (cleaned.length > max) throw new Error(`${field} must not exceed ${max} characters.`);
  assertNoSecretText(cleaned, field);
  return cleaned;
}

export function optionalText(value: unknown, field: string): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return requiredText(value, field);
}

export function normalizeCents(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_RATE_CENTS
  ) {
    throw new Error(`${field} must be an integer number of cents from 0 to ${MAX_RATE_CENTS}.`);
  }
  return value;
}

export function normalizeBps(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_BPS) {
    throw new Error(`${field} must be an integer basis-point value from 0 to ${MAX_BPS}.`);
  }
  return value;
}

export function normalizeSequence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SEQUENCE) {
    throw new Error(`${field} must be an integer from 1 to ${MAX_SEQUENCE}.`);
  }
  return value;
}

export function normalizePrefix(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const cleaned = requiredText(value, field, MAX_PREFIX_LENGTH).toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(cleaned)) {
    throw new Error(`${field} may contain only letters, numbers, and hyphens.`);
  }
  return cleaned;
}

function normalizeContact(value: unknown): BusinessContactDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return {
    ...(optionalText(input.phone, "Business phone") === undefined
      ? {}
      : { phone: optionalText(input.phone, "Business phone") }),
    ...(optionalText(input.email, "Business email") === undefined
      ? {}
      : { email: optionalText(input.email, "Business email") }),
    ...(optionalText(input.website, "Business website") === undefined
      ? {}
      : { website: optionalText(input.website, "Business website") }),
    ...(optionalText(input.abn, "Business ABN") === undefined
      ? {}
      : { abn: optionalText(input.abn, "Business ABN") }),
  };
}

function normalizePayment(value: unknown): BusinessPaymentDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return {
    ...(optionalText(input.bankName, "Payment bankName") === undefined
      ? {}
      : { bankName: optionalText(input.bankName, "Payment bankName") }),
    ...(optionalText(input.accountName, "Payment accountName") === undefined
      ? {}
      : { accountName: optionalText(input.accountName, "Payment accountName") }),
    ...(optionalText(input.bsb, "Payment BSB") === undefined
      ? {}
      : { bsb: optionalText(input.bsb, "Payment BSB") }),
    ...(optionalText(input.accountNumber, "Payment accountNumber") === undefined
      ? {}
      : { accountNumber: optionalText(input.accountNumber, "Payment accountNumber") }),
    ...(optionalText(input.paymentReferenceTemplate, "Payment reference template") === undefined
      ? {}
      : {
          paymentReferenceTemplate: optionalText(
            input.paymentReferenceTemplate,
            "Payment reference template",
          ),
        }),
  };
}

function normalizePricing(
  value: unknown,
  fallback: BusinessPricingSettings,
): BusinessPricingSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  return {
    defaultLabourRateCents:
      input.defaultLabourRateCents === undefined
        ? fallback.defaultLabourRateCents
        : normalizeCents(input.defaultLabourRateCents, "Default labour rate"),
    defaultTravelRateCents:
      input.defaultTravelRateCents === undefined
        ? fallback.defaultTravelRateCents
        : normalizeCents(input.defaultTravelRateCents, "Default travel rate"),
    defaultEquipmentRateCents:
      input.defaultEquipmentRateCents === undefined
        ? fallback.defaultEquipmentRateCents
        : normalizeCents(input.defaultEquipmentRateCents, "Default equipment rate"),
    defaultWasteRateCents:
      input.defaultWasteRateCents === undefined
        ? fallback.defaultWasteRateCents
        : normalizeCents(input.defaultWasteRateCents, "Default waste rate"),
    defaultMaterialsMarkupBps:
      input.defaultMaterialsMarkupBps === undefined
        ? fallback.defaultMaterialsMarkupBps
        : normalizeBps(input.defaultMaterialsMarkupBps, "Default materials markup"),
    defaultMarginBps:
      input.defaultMarginBps === undefined
        ? fallback.defaultMarginBps
        : normalizeBps(input.defaultMarginBps, "Default margin"),
    gstRateBps:
      input.gstRateBps === undefined
        ? fallback.gstRateBps
        : normalizeBps(input.gstRateBps, "GST rate"),
  };
}

function normalizeNumbering(
  value: unknown,
  fallback: BusinessNumberingSettings,
): BusinessNumberingSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  return {
    quotePrefix:
      input.quotePrefix === undefined
        ? fallback.quotePrefix
        : normalizePrefix(input.quotePrefix, "Quote prefix"),
    nextQuoteNumber:
      input.nextQuoteNumber === undefined
        ? fallback.nextQuoteNumber
        : normalizeSequence(input.nextQuoteNumber, "Next quote number"),
    invoicePrefix:
      input.invoicePrefix === undefined
        ? fallback.invoicePrefix
        : normalizePrefix(input.invoicePrefix, "Invoice prefix"),
    nextInvoiceNumber:
      input.nextInvoiceNumber === undefined
        ? fallback.nextInvoiceNumber
        : normalizeSequence(input.nextInvoiceNumber, "Next invoice number"),
  };
}

export function normalizeSettings(value: unknown, fallback: BusinessSettings): BusinessSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  const createdAt = typeof input.createdAt === "number" ? input.createdAt : fallback.createdAt;
  return {
    ...fallback,
    businessName:
      typeof input.businessName === "string"
        ? requiredText(input.businessName, "Business name")
        : fallback.businessName,
    tradingName:
      typeof input.tradingName === "string"
        ? requiredText(input.tradingName, "Trading name")
        : fallback.tradingName,
    gstRegistered:
      typeof input.gstRegistered === "boolean" ? input.gstRegistered : fallback.gstRegistered,
    contactDetails: normalizeContact(input.contactDetails),
    paymentDetails: normalizePayment(input.paymentDetails),
    pricing: normalizePricing(input.pricing, fallback.pricing),
    numbering: normalizeNumbering(input.numbering, fallback.numbering),
    createdAt,
    updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : createdAt,
  };
}

export function applySettingsUpdate(
  current: BusinessSettings,
  update: BusinessSettingsUpdate,
  now = Date.now(),
): BusinessSettings {
  const next: BusinessSettings = {
    ...current,
    contactDetails: { ...current.contactDetails },
    paymentDetails: { ...current.paymentDetails },
    pricing: { ...current.pricing },
    numbering: { ...current.numbering },
  };
  if (update.businessName !== undefined)
    next.businessName = requiredText(update.businessName, "Business name");
  if (update.tradingName !== undefined)
    next.tradingName = requiredText(update.tradingName, "Trading name");
  if (update.gstRegistered !== undefined) next.gstRegistered = update.gstRegistered;
  if (update.contactDetails !== undefined) {
    for (const [key, value] of Object.entries(update.contactDetails)) {
      if (value === null) delete (next.contactDetails as Record<string, string>)[key];
      else if (value !== undefined)
        (next.contactDetails as Record<string, string>)[key] = requiredText(
          value,
          `Business ${key}`,
        );
    }
  }
  if (update.paymentDetails !== undefined) {
    for (const [key, value] of Object.entries(update.paymentDetails)) {
      if (value === null) delete (next.paymentDetails as Record<string, string>)[key];
      else if (value !== undefined)
        (next.paymentDetails as Record<string, string>)[key] = requiredText(
          value,
          `Payment ${key}`,
        );
    }
  }
  if (update.pricing !== undefined) {
    next.pricing = normalizePricing(update.pricing, next.pricing);
  }
  if (update.numbering !== undefined) {
    next.numbering = normalizeNumbering(update.numbering, next.numbering);
  }
  return { ...next, updatedAt: now };
}
