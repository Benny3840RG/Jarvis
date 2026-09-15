import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { commissioningDevelopmentUrl } from "./developmentTarget.js";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import {
  isLoopbackHost,
  resolveHttpAppConfig,
  resolveHttpListenConfig,
  resolveOidcConfig,
  type HttpAppConfig,
  type OidcConfig,
} from "../../http/config.js";
import { createOidcVerifier } from "../../http/oidcVerifier.js";
import { CommissioningEvidenceLog } from "./evidence.js";
import { CommissioningIngressRunner } from "./ingress.js";
import { CommissioningIngressModule } from "./module.js";

export type CommissioningBootstrapEnv = NodeJS.ProcessEnv;

export type CommissioningBootstrapConfig = {
  config: HttpAppConfig & { authMode: "oidc"; oidc: OidcConfig };
  host: string;
  port: number;
  campaignId: string;
  serviceToken: string;
  convexUrl: string;
};

class CommissioningBootstrapError extends Error {}

function required(env: CommissioningBootstrapEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new CommissioningBootstrapError(
      `Isolated-ingress commissioning requires ${key}. Set an approved development value before starting.`,
    );
  }
  return value;
}

/**
 * Assembles the OIDC-forced config for the commissioning bootstrap **without
 * changing `resolveHttpAppConfig`**: it takes the normal resolved config
 * (which on a loopback host still reports `authMode: "service-token"`) and
 * explicitly forces `authMode: "oidc"` plus a required OIDC block. The listener
 * stays on the loopback host `resolveHttpListenConfig` returns, and the
 * bootstrap refuses to start on any non-loopback host.
 */
export function resolveCommissioningBootstrapConfig(
  env: CommissioningBootstrapEnv = process.env,
): CommissioningBootstrapConfig {
  // Refuse a non-loopback host up front, before `resolveHttpListenConfig` would
  // demand the full remote-gateway boundary — this bootstrap is loopback-only.
  const rawHost = (env.JARVIS_HTTP_HOST ?? "127.0.0.1").trim().toLowerCase();
  if (!isLoopbackHost(rawHost)) {
    throw new CommissioningBootstrapError(
      `Isolated-ingress commissioning must bind a loopback host; JARVIS_HTTP_HOST is "${rawHost}".`,
    );
  }
  const listen = resolveHttpListenConfig(env);

  const base = resolveHttpAppConfig(env);
  const oidc = base.oidc ?? resolveOidcConfig(env, true);
  if (oidc === undefined) {
    throw new CommissioningBootstrapError(
      "Isolated-ingress commissioning requires a full JARVIS_OIDC_* configuration.",
    );
  }

  return {
    config: { ...base, authMode: "oidc", oidc },
    host: listen.host,
    port: listen.port,
    campaignId: env.JARVIS_COMMISSIONING_CAMPAIGN_ID?.trim() || `commissioning-${randomUUID()}`,
    serviceToken: required(env, "JARVIS_SERVICE_TOKEN"),
    convexUrl: commissioningDevelopmentUrl(env),
  };
}

export type CommissioningBootstrap = {
  app: NestFastifyApplication;
  url: string;
  campaignId: string;
  evidence: CommissioningEvidenceLog;
  summary: Record<string, string>;
};

export async function startCommissioningBootstrap(
  env: CommissioningBootstrapEnv = process.env,
  options: { evidenceSink?: (line: unknown) => void } = {},
): Promise<CommissioningBootstrap> {
  const resolved = resolveCommissioningBootstrapConfig(env);
  const evidence = new CommissioningEvidenceLog(
    options.evidenceSink ?? ((entry) => console.log(JSON.stringify(entry))),
  );
  const runner = new CommissioningIngressRunner({
    campaignId: resolved.campaignId,
    evidence,
    serviceToken: resolved.serviceToken,
    client: new ConvexHttpClient(resolved.convexUrl),
  });
  const oidcVerifier = createOidcVerifier(resolved.config.oidc);

  const app = await NestFactory.create<NestFastifyApplication>(
    CommissioningIngressModule.register({ config: resolved.config, oidcVerifier, runner }),
    new FastifyAdapter({ bodyLimit: 64 * 1024 }),
    { abortOnError: false },
  );
  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.listen({ host: resolved.host, port: resolved.port });

  const url = `http://${resolved.host}:${resolved.port}/commissioning/v1/isolated-ingress`;
  return {
    app,
    url,
    campaignId: resolved.campaignId,
    evidence,
    summary: {
      authMode: "oidc",
      host: resolved.host,
      port: String(resolved.port),
      issuer: resolved.config.oidc.issuer,
      audience: resolved.config.oidc.audience,
      subject: resolved.config.oidc.subject,
      convexUrl: resolved.convexUrl,
      campaignId: resolved.campaignId,
    },
  };
}
