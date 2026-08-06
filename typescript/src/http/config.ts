import { isIP } from "node:net";

import { resolveRemoteGatewayConfig, type RemoteGatewayConfig } from "./remoteGateway.js";

export const JARVIS_VERSION = "0.1.0";

export type OidcConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  clockSkewSeconds: number;
};

export type HttpAppConfig = {
  version: string;
  sourceVersion: string;
  deploymentVersion: string | null;
  timezone?: string;
  currentToken?: string;
  previousToken?: string;
  currentApprovalToken?: string;
  previousApprovalToken?: string;
  authMode?: "service-token" | "oidc";
  oidc?: OidcConfig;
  remoteGateway?: RemoteGatewayConfig;
};

export type HttpListenConfig = {
  host: string;
  port: number;
};

type JarvisEnvironment = NodeJS.ProcessEnv;

function optionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

const MIN_SERVICE_TOKEN_LENGTH = 32;

function optionalSecret(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  if (/\s/.test(value)) {
    throw new Error("Jarvis service tokens must not contain whitespace.");
  }
  if (value.length < MIN_SERVICE_TOKEN_LENGTH) {
    throw new Error(
      `Jarvis service tokens must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters.`,
    );
  }
  return value;
}

function resolveSourceVersion(value: string | undefined): string {
  const sourceVersion = optionalText(value) ?? "development";
  if (
    sourceVersion.length < 7 ||
    sourceVersion.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/+:@-]*$/.test(sourceVersion)
  ) {
    throw new Error("JARVIS_SOURCE_VERSION must contain between 7 and 64 characters.");
  }
  return sourceVersion;
}

function resolveDeploymentVersion(value: string | undefined): string | null {
  const deploymentVersion = optionalText(value);
  if (deploymentVersion === undefined) return null;
  if (
    deploymentVersion.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/+:@-]*$/.test(deploymentVersion)
  ) {
    throw new Error("JARVIS_DEPLOYMENT_VERSION must be a safe identifier up to 128 characters.");
  }
  return deploymentVersion;
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
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function secureUrl(value: string | undefined, field: string): string | undefined {
  const raw = optionalText(value);
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${field} must be a valid HTTPS URL without credentials, query strings or fragments.`);
  }
  return parsed.toString();
}

function resolveOidcConfig(env: JarvisEnvironment, required: boolean): OidcConfig | undefined {
  const issuer = secureUrl(env.JARVIS_OIDC_ISSUER, "JARVIS_OIDC_ISSUER");
  const jwksUrl = secureUrl(env.JARVIS_OIDC_JWKS_URL, "JARVIS_OIDC_JWKS_URL");
  const audience = optionalText(env.JARVIS_OIDC_AUDIENCE);
  const provided = issuer !== undefined || jwksUrl !== undefined || audience !== undefined;
  if (!required && !provided) return undefined;
  if (issuer === undefined || jwksUrl === undefined || audience === undefined) {
    throw new Error(
      "Remote HTTP exposure requires JARVIS_OIDC_ISSUER, JARVIS_OIDC_AUDIENCE and JARVIS_OIDC_JWKS_URL.",
    );
  }
  if (audience.length > 256 || /[\s]/.test(audience)) {
    throw new Error("JARVIS_OIDC_AUDIENCE must be a bounded value without whitespace.");
  }
  const rawSkew = optionalText(env.JARVIS_OIDC_CLOCK_SKEW_SECONDS) ?? "30";
  if (!/^\d+$/.test(rawSkew)) {
    throw new Error("JARVIS_OIDC_CLOCK_SKEW_SECONDS must be an integer between 0 and 300.");
  }
  const clockSkewSeconds = Number(rawSkew);
  if (!Number.isSafeInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 300) {
    throw new Error("JARVIS_OIDC_CLOCK_SKEW_SECONDS must be an integer between 0 and 300.");
  }
  return { issuer, audience, jwksUrl, clockSkewSeconds };
}

export function resolveHttpAppConfig(env: JarvisEnvironment = process.env): HttpAppConfig {
  const timezone = optionalText(env.JARVIS_TIMEZONE);
  const rawHost = optionalText(env.JARVIS_HTTP_HOST) ?? "127.0.0.1";
  const remote = !isLoopbackHost(rawHost.toLowerCase());
  const remoteGateway = remote ? resolveRemoteGatewayConfig(env) : undefined;
  const oidc = resolveOidcConfig(env, remote);
  const currentToken = optionalSecret(env.JARVIS_SERVICE_TOKEN);
  const previousToken = optionalSecret(env.JARVIS_SERVICE_TOKEN_PREVIOUS);
  const currentApprovalToken = optionalSecret(env.JARVIS_APPROVAL_TOKEN);
  const previousApprovalToken = optionalSecret(env.JARVIS_APPROVAL_TOKEN_PREVIOUS);
  return {
    version: JARVIS_VERSION,
    sourceVersion: resolveSourceVersion(env.JARVIS_SOURCE_VERSION),
    deploymentVersion: resolveDeploymentVersion(env.JARVIS_DEPLOYMENT_VERSION),
    ...(timezone === undefined ? {} : { timezone }),
    ...(currentToken === undefined ? {} : { currentToken }),
    ...(previousToken === undefined ? {} : { previousToken }),
    ...(currentApprovalToken === undefined ? {} : { currentApprovalToken }),
    ...(previousApprovalToken === undefined ? {} : { previousApprovalToken }),
    authMode: remote ? "oidc" : "service-token",
    ...(oidc === undefined ? {} : { oidc }),
    ...(remoteGateway === undefined ? {} : { remoteGateway }),
  };
}

export function resolveHttpListenConfig(env: JarvisEnvironment = process.env): HttpListenConfig {
  const rawHost = optionalText(env.JARVIS_HTTP_HOST) ?? "127.0.0.1";
  if (!validHost(rawHost)) {
    throw new Error("JARVIS_HTTP_HOST must be a valid IP address or hostname.");
  }
  const host = rawHost.toLowerCase();
  if (!isLoopbackHost(host)) {
    resolveRemoteGatewayConfig(env);
    resolveOidcConfig(env, true);
  }

  const rawPort = optionalText(env.JARVIS_HTTP_PORT) ?? "3000";
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("JARVIS_HTTP_PORT must be an integer between 1 and 65535.");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("JARVIS_HTTP_PORT must be an integer between 1 and 65535.");
  }

  return { host, port };
}
