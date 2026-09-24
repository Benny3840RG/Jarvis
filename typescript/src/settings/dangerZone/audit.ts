import fs from "node:fs/promises";
import path from "node:path";

import type { DangerZoneActionId } from "./confirm.js";
import type { DangerZoneProvider } from "./catalog.js";
import { nodeErrorCode } from "./errors.js";

export type DangerZoneAuditRecord = {
  actionId: DangerZoneActionId;
  timestamp: string;
  provider: DangerZoneProvider;
  pid: number;
  hostname: string;
  outcome: "success";
  convexDataDeletes: 0;
  quarantinedBasenames: string[];
};

export function dangerZoneAuditLine(record: DangerZoneAuditRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export async function appendDangerZoneAudit(
  filePath: string,
  record: DangerZoneAuditRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "a", 0o600);
  try {
    await handle.writeFile(dangerZoneAuditLine(record), "utf8");
  } catch (error: unknown) {
    const code = nodeErrorCode(error) ?? "error";
    throw new Error(`Cannot write the Danger zone audit log (${code}).`, { cause: error });
  } finally {
    await handle.close();
  }
}
