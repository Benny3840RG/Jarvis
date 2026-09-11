/**
 * Minimal ANSI styling for terminal output. No dependency — the repository
 * keeps its dependency surface tight — and every helper is a no-op when
 * `enabled` is false so the same renderer serves a colour TTY, a pipe, a
 * `--no-color` run, and assertion-friendly tests.
 */

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

// Built from ESC at runtime so no literal control character appears in source
// (keeps `no-control-regex` happy).
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Strips every SGR escape so visible content can be measured or asserted. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

/** Printable column width of a string, ignoring SGR escapes. */
export function visibleWidth(value: string): number {
  return [...stripAnsi(value)].length;
}

export interface TerminalStyle {
  readonly enabled: boolean;
  bold(value: string): string;
  dim(value: string): string;
  green(value: string): string;
  red(value: string): string;
  violet(value: string): string;
  cyan(value: string): string;
  amber(value: string): string;
  grey(value: string): string;
  /** Inverse video, for the header ribbon. */
  invert(value: string): string;
}

export function createTerminalStyle(enabled: boolean): TerminalStyle {
  const sgr =
    (open: string, close: string) =>
    (value: string): string =>
      enabled ? `${CSI}${open}m${value}${CSI}${close}m` : value;

  return {
    enabled,
    bold: sgr("1", "22"),
    dim: sgr("2", "22"),
    green: sgr("32", "39"),
    red: sgr("31", "39"),
    // The HUD's violet has no 16-colour equal; bright magenta is the closest.
    violet: sgr("95", "39"),
    cyan: sgr("36", "39"),
    amber: sgr("33", "39"),
    grey: sgr("90", "39"),
    invert: sgr("7", "27"),
  };
}

/** Pads `value` to `width` printable columns, ignoring embedded SGR escapes. */
export function padVisible(value: string, width: number): string {
  const deficit = width - visibleWidth(value);
  return deficit > 0 ? value + " ".repeat(deficit) : value;
}

/**
 * Truncates to `width` printable columns with a trailing ellipsis. Drops any
 * SGR escapes in the process, so only use it on already-plain text.
 */
export function truncateVisible(value: string, width: number): string {
  const plain = [...stripAnsi(value)];
  if (plain.length <= width) return plain.join("");
  if (width <= 1) return plain.slice(0, Math.max(0, width)).join("");
  return `${plain.slice(0, width - 1).join("")}…`;
}
