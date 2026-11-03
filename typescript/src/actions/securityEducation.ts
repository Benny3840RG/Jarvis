import { z } from "zod";

import {
  canonicalFileMode,
  fileModeSummary,
  canonicalOctalMode,
  canonicalUmask,
  umaskSummary,
  octalFileModeSummary,
} from "./fileModeEducation.js";
import type { ToolExecutionDefinition } from "./toolExecution.js";

const LESSONS = {
  ports:
    "A transport port identifies an endpoint used by a network service. An open observation suggests a listener was reachable from the observer at that time; it does not prove the service identity or a vulnerability.",
  dns: "DNS maps names to resource records, including addresses. A DNS answer is not permission to contact a system, and addresses can change between resolution and use.",
  tls: "TLS protects data in transit and can authenticate peers using certificates. Encryption alone does not prove an endpoint is trustworthy; certificate identity and validation still matter.",
  phishing:
    "Phishing uses deceptive messages or sites to obtain information or trigger actions. Verify unusual requests through a separately known contact method, rather than a link or number supplied in the message.",
  permissions:
    "Linux file permissions separate owner, group and other access. Read, write and execute have different meanings for files and directories; directory execute permits traversal. ACLs and other controls can also affect access.",
  "least-privilege":
    "Least privilege grants only the access required for a specific task and duration. Separate routine work from administration and remove access when it is no longer required.",
} as const;

export type SecurityEducation = {
  version: 1;
  supported: boolean;
  summary: string;
  limitations: string;
};

const LIMITATIONS =
  "Education only, based on supplied text, not a live inspection or vulnerability assessment. It does not establish authorisation, service identity, internet exposure or system safety. No commands or network requests were run.";
const UNKNOWN: SecurityEducation = {
  version: 1,
  supported: false,
  summary:
    "Unsupported diagnostic text. Supply only a PORT STATE SERVICE header (optional) and port/protocol state rows, optionally followed by a short service label. No conclusion can be drawn from this input.",
  limitations: LIMITATIONS,
};
const explainSchema = z
  .object({
    topic: z.enum(Object.keys(LESSONS) as [keyof typeof LESSONS, ...(keyof typeof LESSONS)[]]),
  })
  .strict();
const interpretSchema = z.discriminatedUnion("format", [
  z.object({ format: z.literal("umask"), output: z.string().min(1).max(8192) }).strict(),
  z.object({ format: z.literal("port-states"), output: z.string().min(1).max(8192) }).strict(),
  z.object({ format: z.literal("file-mode"), output: z.string().min(1).max(8192) }).strict(),
  z
    .object({
      format: z.literal("file-mode-octal"),
      kind: z.enum(["file", "directory"]),
      output: z.string().min(1).max(8192),
    })
    .strict(),
]);

// Deliberately a narrow grammar, not a command parser or a general Nmap report parser.
// Full-line matching prevents pasted instructions and metadata from becoming observations.
function portRows(output: string): Array<{ port: number; protocol: string; state: string }> | null {
  for (const character of output) {
    const code = character.charCodeAt(0);
    if (code !== 9 && code !== 10 && code !== 13 && (code < 32 || code > 126)) return null;
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (/^PORT[ \t]+STATE[ \t]+SERVICE$/.test(lines[0] ?? "")) lines.shift();
  if (lines.length === 0 || lines.length > 128) return null;
  const rows = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match =
      /^(\d{1,5})\/(tcp|udp)\s+(open|closed|filtered|unfiltered|open\|filtered|closed\|filtered)(?:\s+[a-zA-Z0-9?][a-zA-Z0-9?_-]{0,31})?$/.exec(
        line,
      );
    if (!match) return null;
    const port = Number(match[1]);
    const key = `${port}/${match[2]}`;
    if (port < 1 || port > 65535 || seen.has(key)) return null;
    seen.add(key);
    rows.push({ port, protocol: match[2]!, state: match[3]! });
  }
  return rows;
}

/** Minimise diagnostic data BEFORE proposal storage, fingerprints and approval. */
export function prepareSecurityArguments(
  operation: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (operation === "explain") return explainSchema.parse(args);
  if (operation !== "interpret") throw new Error("Unsupported security education operation.");
  const parsed = interpretSchema.parse(args);
  if (parsed.format === "umask") {
    return { format: parsed.format, output: canonicalUmask(parsed.output) ?? "[unsupported]" };
  }
  if (parsed.format === "file-mode") {
    return { format: parsed.format, output: canonicalFileMode(parsed.output) ?? "[unsupported]" };
  }
  if (parsed.format === "file-mode-octal") {
    return {
      format: parsed.format,
      kind: parsed.kind,
      output: canonicalOctalMode(parsed.output) ?? "[unsupported]",
    };
  }
  const rows = portRows(parsed.output);
  return {
    format: parsed.format,
    output: rows
      ? rows.map((row) => `${row.port}/${row.protocol} ${row.state}`).join("\n")
      : "[unsupported]",
  };
}

/** Pure bounded interpretation. Never returns any supplied string. */
export function securityEducation(
  operation: string,
  args: Record<string, unknown>,
): SecurityEducation {
  if (operation === "explain") {
    const { topic } = explainSchema.parse(args);
    return { version: 1, supported: true, summary: LESSONS[topic], limitations: LIMITATIONS };
  }
  if (operation !== "interpret") throw new Error("Unsupported security education operation.");
  const parsed = interpretSchema.parse(args);
  const { format, output } = parsed;
  if (format === "umask") {
    const summary = umaskSummary(output);
    return {
      version: 1,
      supported: summary !== null,
      summary:
        summary ??
        "Unsupported umask text. Supply three octal digits (0-7), optionally preceded by zero, without commands, filenames or other text. No conclusion can be drawn from this input.",
      limitations: LIMITATIONS,
    };
  }
  if (parsed.format === "file-mode-octal") {
    const summary = octalFileModeSummary(output, parsed.kind);
    return {
      version: 1,
      supported: summary !== null,
      summary:
        summary ??
        "Unsupported numeric mode. Supply exactly three or four octal digits (0-7) and an explicit file or directory kind. No conclusion can be drawn from this input.",
      limitations: LIMITATIONS,
    };
  }
  if (format === "file-mode") {
    const summary = fileModeSummary(output);
    return {
      version: 1,
      supported: summary !== null,
      summary:
        summary ??
        "Unsupported file-mode text. Supply one ten-character regular-file or directory symbolic mode, such as -rwxr-x---, without names, paths, ACL markers or other listing fields. No conclusion can be drawn from this input.",
      limitations: LIMITATIONS,
    };
  }
  const rows = portRows(output);
  if (!rows) return { ...UNKNOWN };
  const count = (state: string) => rows.filter((row) => row.state === state).length;
  const uncertain = rows.filter(
    (row) => row.state.includes("|") || row.state === "unfiltered",
  ).length;
  return {
    version: 1,
    supported: true,
    summary: `Supplied rows: ${count("open")} open; ${count("closed")} closed; ${count("filtered")} filtered; ${uncertain} uncertain. Open suggests an accepting service; closed suggests no listener; filtered means filtering prevents a definite open/closed conclusion. Combined states and unfiltered do not establish whether a port is open. These are reported observations, not independently verified facts.`,
    limitations: LIMITATIONS,
  };
}

export function createSecurityEducationTools(): ToolExecutionDefinition[] {
  return ["explain", "interpret"].map((operation) => ({
    tool: "security",
    operation,
    minimumAuthority: "T1",
    schema: operation === "explain" ? explainSchema : interpretSchema,
    async execute(args, signal) {
      signal.throwIfAborted();
      return securityEducation(operation, args);
    },
  }));
}
