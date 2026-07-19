import { isIP } from "node:net";

export const JARVIS_VERSION = "0.1.0";

export type HttpAppConfig = {
  version: string;
  sourceVersion: string;
  deploymentVersion: string | null;
  timezone?: string;
  currentToken?: string;
  previousToken?: string;
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

function optionalSecret(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  if (/\s/.test(value)) {
    throw new Error("Jarvis service tokens must not contain whitespace.");
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

export function resolveHttpAppConfig(env: JarvisEnvironment = process.env): HttpAppConfig {
  const timezone = optionalText(env.JARVIS_TIMEZONE);
  const currentToken = optionalSecret(env.JARVIS_SERVICE_TOKEN);
  const previousToken = optionalSecret(env.JARVIS_SERVICE_TOKEN_PREVIOUS);
  return {
    version: JARVIS_VERSION,
    sourceVersion: resolveSourceVersion(env.JARVIS_SOURCE_VERSION),
    deploymentVersion: resolveDeploymentVersion(env.JARVIS_DEPLOYMENT_VERSION),
    ...(timezone === undefined ? {} : { timezone }),
    ...(currentToken === undefined ? {} : { currentToken }),
    ...(previousToken === undefined ? {} : { previousToken }),
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function resolveHttpListenConfig(env: JarvisEnvironment = process.env): HttpListenConfig {
  const rawHost = optionalText(env.JARVIS_HTTP_HOST) ?? "127.0.0.1";
  if (!validHost(rawHost)) {
    throw new Error("JARVIS_HTTP_HOST must be a valid IP address or hostname.");
  }
  const host = rawHost.toLowerCase();
  if (!isLoopbackHost(host)) {
    throw new Error(
      "Remote HTTP exposure is disabled until the approved OAuth 2.1, TLS, and deployment boundary exists.",
    );
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
