import type { Asset } from "./asset.js";

const MS_PER_DAY = 86_400_000;

/**
 * An asset plus two derived, read-only fields. Nothing here is stored — it is
 * computed on read from the asset's own service interval and last-serviced date.
 * This is a calculation over what Benny logged, not a live scheduler: it says
 * when a service falls due, it does not watch the clock or send reminders.
 */
export type AssetView = Asset & {
  /** When the next service falls due, when both interval and last-serviced are known. */
  nextDueAt?: number;
  /** True when nextDueAt is known and has already passed. */
  due: boolean;
};

/** Derives the maintenance view of an asset as of `now`. Pure. */
export function deriveAssetView(asset: Asset, now: number = Date.now()): AssetView {
  const nextDueAt =
    asset.lastServicedAt !== undefined && asset.serviceIntervalDays !== undefined
      ? asset.lastServicedAt + asset.serviceIntervalDays * MS_PER_DAY
      : undefined;
  const due = nextDueAt !== undefined && nextDueAt <= now;
  return { ...asset, ...(nextDueAt === undefined ? {} : { nextDueAt }), due };
}
