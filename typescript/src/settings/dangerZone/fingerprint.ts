import { createHash } from "node:crypto";

/** Short display of the current token. This is not the token and cannot rebuild it. */
export function tokenFingerprint(token: string | undefined): string | null {
  if (token === undefined || token.length === 0) return null;
  const hex = createHash("sha256").update(token, "utf8").digest("hex");
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
  return secrets.reduce((safe, secret) => {
    if (secret.length < 8) return safe;
    return safe.split(secret).join("[REDACTED]");
  }, message);
}
