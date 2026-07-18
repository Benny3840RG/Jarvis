import { isIP } from "node:net";

export type JarvisApiConfig = {
  baseUrl: URL;
  serviceToken: string;
};

export type JarvisMcpConfig = {
  host: string;
  port: number;
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

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function resolveHost(env: NodeJS.ProcessEnv): string {
  const host = optionalText(env.JARVIS_MCP_HOST) ?? "127.0.0.1";
  if (!validHost(host)) throw new Error("JARVIS_MCP_HOST must be a valid IP address or hostname.");
  if (!isLoopbackHost(host) && env.JARVIS_MCP_ALLOW_REMOTE !== "true") {
    throw new Error(
      "Non-loopback JARVIS_MCP_HOST requires JARVIS_MCP_ALLOW_REMOTE=true for an explicit preview-only override.",
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
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.search = "";
  url.hash = "";
  return url;
}

export function resolveJarvisMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): JarvisMcpConfig {
  return {
    host: resolveHost(env),
    port: parsePort(env.JARVIS_MCP_PORT),
    api: {
      baseUrl: resolveApiBaseUrl(env),
      serviceToken: requiredSecret(env.JARVIS_SERVICE_TOKEN, "JARVIS_SERVICE_TOKEN"),
    },
  };
}
