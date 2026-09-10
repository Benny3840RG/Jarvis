/**
 * The single size bound for every archive v4 read and write.
 *
 * The bound exists to stop a runaway read: a corrupt or hostile file must not be
 * pulled wholly into memory. It is deliberately one number applied on both
 * sides, because an archive that can be written but not read back — or a source
 * that can be read but never written to an archive — is worse than either limit
 * on its own.
 *
 * It is also overridable. A backup that silently stops being possible as the
 * business grows is not a safety property, and the operator only ever finds out
 * at the moment they need it, so the limit names its own escape hatch in every
 * message it produces.
 */

export const ARCHIVE_BYTES_ENV = "JARVIS_ARCHIVE_MAX_BYTES";

/** 64 MiB. Roughly 100,000 invoice-sized records; a sole trader will not reach it. */
export const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const MIN_MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

/** Markers are a handful of fields; nothing legitimate approaches this. */
export const MAX_MARKER_BYTES = 1024 * 1024;

export function resolveMaxArchiveBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ARCHIVE_BYTES_ENV];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_ARCHIVE_BYTES;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `${ARCHIVE_BYTES_ENV} must be a whole number of bytes between ${String(MIN_MAX_ARCHIVE_BYTES)} and ${String(MAX_MAX_ARCHIVE_BYTES)}.`,
    );
  }
  const bytes = Number(raw.trim());
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < MIN_MAX_ARCHIVE_BYTES ||
    bytes > MAX_MAX_ARCHIVE_BYTES
  ) {
    throw new Error(
      `${ARCHIVE_BYTES_ENV} must be a whole number of bytes between ${String(MIN_MAX_ARCHIVE_BYTES)} and ${String(MAX_MAX_ARCHIVE_BYTES)}.`,
    );
  }
  return bytes;
}

/** The advice every size failure ends with, so a refusal is never a dead end. */
export function overLimitAdvice(limit: number): string {
  return `The limit is ${String(limit)} bytes; raise it with ${ARCHIVE_BYTES_ENV} if this data is genuinely this large.`;
}
