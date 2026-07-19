import type { SystemStatus } from "../http/contracts.js";
import { resolveHttpListenConfig } from "../http/config.js";
import { resolveJarvisMcpConfig } from "../mcp/config.js";
import { resolvePreviewEnvironment } from "./environment.js";

export const AUTHORISED_DEVELOPMENT_DEPLOYMENT = "dev:outgoing-ram-798";
export const AUTHORISED_CONVEX_URL = "https://outgoing-ram-798.convex.cloud";

export const REQUIRED_PADDOCK_TOOLS = [
  "show_jarvis_dashboard",
  "get_jarvis_status",
  "list_tasks",
  "list_reminders",
] as const;

export type PaddockConfig = {
  environment: NodeJS.ProcessEnv;
  deployment: string;
  httpUrl: URL;
  mcpUrl: URL;
  serviceToken: string;
};

function requiredText(value: string | undefined, field: string): string {
  const cleaned = value?.trim();
  if (!cleaned)
    throw new Error(`${field} is required for the Jarvis development paddock.`);
  return cleaned;
}

function normalizedUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function resolvePaddockConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaddockConfig {
  const environment = resolvePreviewEnvironment(env);
  const provider = requiredText(
    environment.PERSISTENCE_PROVIDER,
    "PERSISTENCE_PROVIDER",
  );
  if (provider !== "convex") {
    throw new Error(
      "PERSISTENCE_PROVIDER must be convex for the Jarvis development paddock.",
    );
  }

  const deployment = requiredText(
    environment.CONVEX_DEPLOYMENT,
    "CONVEX_DEPLOYMENT",
  );
  if (deployment !== AUTHORISED_DEVELOPMENT_DEPLOYMENT) {
    throw new Error(
      `CONVEX_DEPLOYMENT must be ${AUTHORISED_DEVELOPMENT_DEPLOYMENT}; production is not authorised.`,
    );
  }

  const convexUrl = normalizedUrl(
    requiredText(environment.CONVEX_URL, "CONVEX_URL"),
  );
  if (convexUrl !== AUTHORISED_CONVEX_URL) {
    throw new Error(`CONVEX_URL must be ${AUTHORISED_CONVEX_URL}.`);
  }

  const deploymentVersion = requiredText(
    environment.JARVIS_DEPLOYMENT_VERSION,
    "JARVIS_DEPLOYMENT_VERSION",
  );
  if (deploymentVersion !== deployment) {
    throw new Error("JARVIS_DEPLOYMENT_VERSION must match CONVEX_DEPLOYMENT.");
  }

  requiredText(environment.OPENAI_API_KEY, "OPENAI_API_KEY");

  const http = resolveHttpListenConfig(environment);
  const httpUrl = new URL(`http://${urlHost(http.host)}:${http.port}/`);
  const mcp = resolveJarvisMcpConfig({
    ...environment,
    JARVIS_API_BASE_URL: environment.JARVIS_API_BASE_URL ?? httpUrl.toString(),
  });
  const mcpUrl = new URL(`http://${urlHost(mcp.host)}:${mcp.port}/mcp`);

  return {
    environment: {
      ...environment,
      CONVEX_DEPLOYMENT: deployment,
      CONVEX_URL: convexUrl,
      JARVIS_DEPLOYMENT_VERSION: deploymentVersion,
      JARVIS_API_BASE_URL:
        environment.JARVIS_API_BASE_URL ?? httpUrl.toString(),
    },
    deployment,
    httpUrl,
    mcpUrl,
    serviceToken: mcp.api.serviceToken,
  };
}

export function assertPaddockStatus(
  status: SystemStatus,
  deployment: string,
): void {
  if (status.status !== "ok")
    throw new Error(`Jarvis status is ${status.status}.`);
  if (status.provider.name !== "convex")
    throw new Error("Jarvis is not using Convex persistence.");
  if (status.provider.reachability !== "ok")
    throw new Error("Convex is not reachable.");
  if (status.provider.authentication !== "ok")
    throw new Error("Convex authentication failed.");
  if (status.provider.schemaCompatibility !== "compatible") {
    throw new Error("Convex schema compatibility check failed.");
  }
  if (status.provider.deploymentVersion !== deployment) {
    throw new Error(
      `Jarvis reported deployment ${String(status.provider.deploymentVersion)} instead of ${deployment}.`,
    );
  }
}
