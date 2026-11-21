export type AuditAllowlistEntry = Readonly<{
  reason: string;
  added?: string;
  expires: string;
  devOnly: boolean;
}>;

export type BlockingAdvisory = Readonly<{
  id: string;
  title: string;
  severity: string;
  reason: "not-allowlisted" | "allowlist-expired" | "reaches-production";
}>;

export const ALLOWLIST: Map<string, AuditAllowlistEntry & { added: string }>;

export function evaluateAudit(input: {
  full: unknown;
  production: unknown;
  today: string;
  allowlist?: Map<string, AuditAllowlistEntry>;
}): BlockingAdvisory[];
