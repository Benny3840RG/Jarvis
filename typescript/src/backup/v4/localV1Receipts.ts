/** Task and reminder idempotency rows captured beside S6. Not an S6 table. */
export const LOCAL_V1_RECEIPT_TABLES = ["directCreateReceipts", "internalActionResults"] as const;
export type LocalV1ReceiptTable = (typeof LOCAL_V1_RECEIPT_TABLES)[number];
export const LOCAL_V1_RECEIPT_CAPTURE_VERSION = "archive-v4-local-v1-receipts:v1";
/** Same per-table bound as S6. Overflow aborts; it does not truncate. */
export const LOCAL_V1_RECEIPT_ROW_CAP = 100;
