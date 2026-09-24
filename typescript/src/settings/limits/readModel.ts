/**
 * Settings → Limits read model.
 *
 * Benny has not selected a durable quota store. This module does not read or
 * write Convex, JSON, or environment limits, and it does not invent usage.
 */

export const LIMITS_PAGE_HREF = "/settings/limits" as const;

export const CHANGE_LIMIT_PHRASE = "CHANGE LIMIT";

export const QUOTA_CHIP_STATES = ["OK", "WARN", "STOPPED", "UNKNOWN", "NO LIMIT"] as const;

export type QuotaChipState = (typeof QUOTA_CHIP_STATES)[number];

export const PROVIDER_QUOTA_RESOURCES = [
  {
    id: "api-provider-rate",
    title: "API / provider rate",
    hitHard:
      "A hard stop on API / provider rate would refuse new provider calls. Calls already sent are not rolled back.",
  },
  {
    id: "concurrency",
    title: "Concurrency",
    hitHard:
      "A hard stop on concurrency would refuse new overlapping work. Work already running is not cancelled by this page.",
  },
  {
    id: "storage-backup",
    title: "Storage / backup",
    hitHard:
      "A hard stop on storage / backup would refuse new backup writes. Existing archives are not deleted by this page.",
  },
  {
    id: "retention",
    title: "Retention",
    hitHard:
      "A hard stop on retention would refuse new expiry. Stored records are not deleted by this page.",
  },
  {
    id: "delivery",
    title: "Delivery",
    hitHard:
      "A hard stop on delivery would refuse new sends. Messages already handed off are not recalled by this page.",
  },
] as const;

export type ProviderQuotaResourceId = (typeof PROVIDER_QUOTA_RESOURCES)[number]["id"];

export type ProviderQuotaResource = {
  id: ProviderQuotaResourceId;
  title: string;
  softLabel: "Soft";
  hardLabel: "Hard";
  hardStop: "No hard stop";
  chip: "UNKNOWN";
  used: null;
  limit: null;
  remaining: null;
  resetPeriod: "Unknown";
  hitHard: string;
  changeLimit: string;
};

export type NowChip = {
  count: 1;
  state: QuotaChipState;
  href: typeof LIMITS_PAGE_HREF;
  editable: false;
  label: string;
};

export type ProviderQuotaReadModel = {
  store: "unread";
  enforced: false;
  partial: "Partial OK";
  operatorOnly: true;
  banner: string;
  resetPeriod: "Unknown";
  resources: readonly ProviderQuotaResource[];
  nowChip: NowChip;
};

const SEVERITY: Record<QuotaChipState, number> = {
  STOPPED: 4,
  WARN: 3,
  UNKNOWN: 2,
  OK: 1,
  "NO LIMIT": 0,
};

const CHANGE_LIMIT_COPY =
  "Changing this limit is not saved. The durable quota store is pending Benny's choice. Nothing is enforced.";

export const LIMITS_STORE_BANNER =
  "Limits are not durably enforced yet. The quota store is pending Benny's choice. This page is a read model only. Partial OK.";

/**
 * One HUD projection. STOPPED outranks WARN, then UNKNOWN, then OK, then NO LIMIT.
 * An empty reading stays UNKNOWN. The chip is never an editor.
 */
export function projectNowChip(states: readonly QuotaChipState[]): NowChip {
  let state: QuotaChipState = "UNKNOWN";
  if (states.length > 0) {
    state = states[0];
    for (const candidate of states) {
      if (SEVERITY[candidate] > SEVERITY[state]) state = candidate;
    }
  }
  return {
    count: 1,
    state,
    href: LIMITS_PAGE_HREF,
    editable: false,
    label: `Limits · ${state}`,
  };
}

/** No durable store is selected, so every provider quota stays unread. */
export function readProviderQuotaLimits(): ProviderQuotaReadModel {
  const resources: ProviderQuotaResource[] = PROVIDER_QUOTA_RESOURCES.map((resource) => ({
    id: resource.id,
    title: resource.title,
    softLabel: "Soft",
    hardLabel: "Hard",
    hardStop: "No hard stop",
    chip: "UNKNOWN",
    used: null,
    limit: null,
    remaining: null,
    resetPeriod: "Unknown",
    hitHard: resource.hitHard,
    changeLimit: CHANGE_LIMIT_COPY,
  }));
  return {
    store: "unread",
    enforced: false,
    partial: "Partial OK",
    operatorOnly: true,
    banner: LIMITS_STORE_BANNER,
    resetPeriod: "Unknown",
    resources,
    nowChip: projectNowChip(resources.map((resource) => resource.chip)),
  };
}
