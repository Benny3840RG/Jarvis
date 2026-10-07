/** Task and reminder idempotency rows captured beside S6. Not an S6 table. */
export const LOCAL_V1_RECEIPT_TABLES = ["directCreateReceipts", "internalActionResults"] as const;
export type LocalV1ReceiptTable = (typeof LOCAL_V1_RECEIPT_TABLES)[number];
export const LOCAL_V1_RECEIPT_CAPTURE_VERSION = "archive-v4-local-v1-receipts:v1";
/** Same per-table bound as S6. Overflow aborts; it does not truncate. */
export const LOCAL_V1_RECEIPT_ROW_CAP = 100;

/**
 * Written into the checksummed receipt payload when a task or reminder was
 * deleted and its direct-create receipt remains. The receipt is restored with
 * the captured entity id so the same idempotency key cannot create a replacement.
 */
export const LOCAL_V1_DIRECT_CREATE_TOMBSTONE_NOTE =
  "Direct-create receipt kept its captured entity id because that task or reminder was already deleted. The idempotency key must not create a replacement.";

export type LocalV1DirectCreateTombstone = {
  table: "directCreateReceipts";
  entityType: "task" | "reminder";
  entityId: string;
  idempotencyKey: string;
  note: typeof LOCAL_V1_DIRECT_CREATE_TOMBSTONE_NOTE;
};
