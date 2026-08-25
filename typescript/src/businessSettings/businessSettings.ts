export interface BusinessContactDetails {
  phone?: string;
  email?: string;
  website?: string;
  abn?: string;
}

export interface BusinessPaymentDetails {
  bankName?: string;
  accountName?: string;
  bsb?: string;
  accountNumber?: string;
  paymentReferenceTemplate?: string;
}

export interface BusinessPricingSettings {
  defaultLabourRateCents: number;
  defaultTravelRateCents: number;
  defaultEquipmentRateCents: number;
  defaultWasteRateCents: number;
  defaultMaterialsMarkupBps: number;
  defaultMarginBps: number;
  gstRateBps: number;
}

export interface BusinessNumberingSettings {
  quotePrefix: string;
  nextQuoteNumber: number;
  invoicePrefix: string;
  nextInvoiceNumber: number;
}

export interface BusinessSettings {
  id: "business-settings";
  businessName: string;
  tradingName: string;
  locale: "en-AU";
  timezone: "Australia/Melbourne";
  currency: "AUD";
  measurementSystem: "metric";
  gstRegistered: boolean;
  contactDetails: BusinessContactDetails;
  paymentDetails: BusinessPaymentDetails;
  pricing: BusinessPricingSettings;
  numbering: BusinessNumberingSettings;
  createdAt: number;
  updatedAt: number;
}

export interface BusinessSettingsUpdate {
  businessName?: string;
  tradingName?: string;
  gstRegistered?: boolean;
  contactDetails?: {
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    abn?: string | null;
  };
  paymentDetails?: {
    bankName?: string | null;
    accountName?: string | null;
    bsb?: string | null;
    accountNumber?: string | null;
    paymentReferenceTemplate?: string | null;
  };
  pricing?: Partial<BusinessPricingSettings>;
  numbering?: Partial<BusinessNumberingSettings>;
}

export interface BusinessSettingsStore {
  get(): Promise<BusinessSettings>;
  update(update: BusinessSettingsUpdate): Promise<BusinessSettings>;
}

export function defaultBusinessSettings(now = Date.now()): BusinessSettings {
  return {
    id: "business-settings",
    businessName: "THE BEEZ TREEZ PROPERTY SOLUTIONS",
    tradingName: "The Beez Treez Property Solutions",
    locale: "en-AU",
    timezone: "Australia/Melbourne",
    currency: "AUD",
    measurementSystem: "metric",
    gstRegistered: true,
    contactDetails: {},
    paymentDetails: {},
    pricing: {
      defaultLabourRateCents: 0,
      defaultTravelRateCents: 0,
      defaultEquipmentRateCents: 0,
      defaultWasteRateCents: 0,
      defaultMaterialsMarkupBps: 0,
      defaultMarginBps: 0,
      gstRateBps: 1000,
    },
    numbering: {
      quotePrefix: "BTQ",
      nextQuoteNumber: 1,
      invoicePrefix: "BTI",
      nextInvoiceNumber: 1,
    },
    createdAt: now,
    updatedAt: now,
  };
}
