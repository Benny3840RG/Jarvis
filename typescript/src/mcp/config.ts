import { isIP } from "node:net";

export type JarvisApiConfig = {
  baseUrl: URL;
  serviceToken: string;
};

export type JarvisMcpConfig = {
  host: string;
  port: number;
  allowedOrigins?: readonly string[];
  api: JarvisApiConfig;
};

function requiredSecret(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${field} is required for the Jarvis MCP preview.`);
  }
  if (/\s/.test(value)) throw new Error(`${field} must not contain whitespace.`);
  return value;
}

function optionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const raw = optionalText(value);
  if (raw === undefined) return [];
  const origins = [
    ...new Set(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("JARVIS_MCP_ALLOWED_ORIGINS must contain valid HTTP(S) origins.");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("JARVIS_MCP_ALLOWED_ORIGINS must contain valid HTTP(S) origins.");
    }
  }
  return origins;
}

function parsePort(value: string | undefined): number {
  const raw = optionalText(value) ?? "8787";
  if (!/^\d+$/.test(raw)) {
    throw new Error("JARVIS_MCP_PORT must be an integer between 1 and 65535.");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("JARVIS_MCP_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function validHost(host: string): boolean {
  if (isIP(host) !== 0 || host === "localhost") return true;
  return (
    host.length <= 253 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) &&
    !host.includes("..")
  );
}

function normalizedHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host.toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizedHost(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function resolveHost(env: NodeJS.ProcessEnv): string {
  const host = optionalText(env.JARVIS_MCP_HOST) ?? "127.0.0.1";
  if (!validHost(host)) throw new Error("JARVIS_MCP_HOST must be a valid IP address or hostname.");
  if (!isLoopbackHost(host)) {
    throw new Error(
      "Remote MCP exposure is disabled until the approved OAuth 2.1, TLS, and deployment boundary exists.",
    );
  }
  return host;
}

function resolveApiBaseUrl(env: NodeJS.ProcessEnv): URL {
  const fallbackPort = optionalText(env.JARVIS_HTTP_PORT) ?? "3000";
  const raw = optionalText(env.JARVIS_API_BASE_URL) ?? `http://127.0.0.1:${fallbackPort}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("JARVIS_API_BASE_URL must be a valid absolute HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("JARVIS_API_BASE_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("JARVIS_API_BASE_URL must not include embedded credentials.");
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(
      "Remote Jarvis API access is disabled until the approved OAuth 2.1, TLS, and deployment boundary exists.",
    );
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.search = "";
  url.hash = "";
  return url;
}

export function resolveJarvisMcpConfig(env: NodeJS.ProcessEnv = process.env): JarvisMcpConfig {
  return {
    host: resolveHost(env),
    port: parsePort(env.JARVIS_MCP_PORT),
    allowedOrigins: parseAllowedOrigins(env.JARVIS_MCP_ALLOWED_ORIGINS),
    api: {
      baseUrl: resolveApiBaseUrl(env),
      serviceToken: requiredSecret(env.JARVIS_SERVICE_TOKEN, "JARVIS_SERVICE_TOKEN"),
    },
  };
}
