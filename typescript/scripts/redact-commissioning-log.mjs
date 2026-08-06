import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
const RESIDUAL_SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_\-]{12,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/i,
  /\bBasic\s+[A-Za-z0-9+/=_-]{16,}\b/i,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\b[A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|DEPLOY[_-]?KEY|CREDENTIALS?)\s*[:=]\s*(?!\[REDACTED\])[^\s"',]+/i,
  /[?&](?:api[_-]?key|token|secret)=([^&\s]+)/i,
];

const SECRET_ENV_NAME =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|DEPLOY[_-]?KEY|CREDENTIALS?)/i;

export class RedactionError extends Error {
  constructor() {
    super("Commissioning diagnostic redaction could not be proven safe.");
    this.name = "RedactionError";
  }
}

export function secretValuesFromEnvironment(env = process.env) {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        SECRET_ENV_NAME.test(name) && typeof value === "string" && value.length > 0,
    )
    .map(([, value]) => value);
}

export function redactCommissioningLog(input, secrets) {
  let output = String(input ?? "").replace(ANSI_ESCAPE, "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      output = output.split(secret).join("[REDACTED]");
    }
  }

  output = output
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"',]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/(Authorization\s*:\s*Basic\s+)[^\s"',]+/gi, "$1[REDACTED]")
    .replace(/(Basic\s+)[A-Za-z0-9+/=_-]{16,}/gi, "$1[REDACTED]")
    .replace(/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_\-]{12,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_PROVIDER_KEY]")
    .replace(
      /((?:OPENAI_API_KEY|JARVIS_SERVICE_TOKEN|CONVEX_DEPLOY_KEY)\s*[:=]\s*)[^\s"',]+/g,
      "$1[REDACTED]",
    )
    .replace(
      /((?:[A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|DEPLOY[_-]?KEY|CREDENTIALS?))\s*[:=]\s*)[^\s"',]+/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/```/g, "` ` `");

  if (
    secrets.some(
      (secret) => typeof secret === "string" && secret.length > 0 && output.includes(secret),
    )
  ) {
    throw new RedactionError();
  }
  if (RESIDUAL_SECRET_PATTERNS.some((pattern) => pattern.test(output))) {
    throw new RedactionError();
  }
  return output;
}

function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) throw new RedactionError();
  const input = fs.existsSync(inputPath) ? fs.readFileSync(inputPath, "utf8") : "";
  const output = redactCommissioningLog(input, [...secretValuesFromEnvironment()]);
  fs.writeFileSync(outputPath, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
