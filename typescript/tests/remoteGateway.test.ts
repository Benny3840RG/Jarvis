import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import {
  evaluateRemoteGatewayRequest,
  resolveRemoteGatewayConfig,
  type RemoteGatewayRequest,
} from "../src/http/remoteGateway.js";
import {
  resolveHttpAppConfig,
  resolveHttpListenConfig,
  type HttpAppConfig,
} from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type GatewayDecision = ReturnType<typeof evaluateRemoteGatewayRequest>;

function rejection(decision: GatewayDecision): string {
  if (decision.allowed) throw new Error("expected gateway rejection");
  return decision.code;
}

const REMOTE_ENV = {
  JARVIS_HTTP_HOST: "0.0.0.0",
  JARVIS_HTTP_PORT: "3000",
  JARVIS_REMOTE_GATEWAY_ENABLED: "true",
  JARVIS_TLS_TERMINATED: "true",
  JARVIS_OIDC_ISSUER: "https://issuer.example.com/",
  JARVIS_OIDC_AUDIENCE: "jarvis-api",
  JARVIS_OIDC_JWKS_URL: "https://issuer.example.com/.well-known/jwks.json",
  JARVIS_OIDC_SUBJECT: "benny",
  JARVIS_ALLOWED_ORIGINS: "https://console.example.com,https://admin.example.com",
  JARVIS_TRUSTED_PROXY: "203.0.113.10",
  JARVIS_SERVICE_TOKEN: "a".repeat(32),
} as const;

describe("remote gateway configuration", () => {
  it("rejects non-loopback binding without the complete remote boundary", () => {
    assert.throws(
      () => resolveHttpListenConfig({ JARVIS_HTTP_HOST: "0.0.0.0" }),
      /remote gateway/i,
    );
    assert.throws(
      () =>
        resolveHttpAppConfig({
          JARVIS_HTTP_HOST: "0.0.0.0",
          JARVIS_REMOTE_GATEWAY_ENABLED: "true",
        }),
      /OIDC|TLS|origin/i,
    );
  });

  it("enables OIDC mode only for a complete remote configuration", () => {
    assert.deepEqual(resolveHttpListenConfig(REMOTE_ENV), {
      host: "0.0.0.0",
      port: 3000,
    });
    const config = resolveHttpAppConfig(REMOTE_ENV);
    assert.equal(config.authMode, "oidc");
    assert.equal(config.oidc?.issuer, "https://issuer.example.com/");
    assert.equal(config.oidc?.subject, "benny");
    assert.deepEqual(config.remoteGateway?.allowedOrigins, [
      "https://console.example.com",
      "https://admin.example.com",
    ]);
    assert.deepEqual(config.remoteGateway?.trustedProxy, ["203.0.113.10"]);
  });

  it("fails closed when no trusted proxy is configured", () => {
    const { JARVIS_TRUSTED_PROXY: _omitted, ...withoutTrustedProxy } = REMOTE_ENV;
    assert.throws(() => resolveRemoteGatewayConfig(withoutTrustedProxy), /JARVIS_TRUSTED_PROXY/);
  });

  it("fails closed on an unrecognisable trusted-proxy entry", () => {
    assert.throws(
      () => resolveRemoteGatewayConfig({ ...REMOTE_ENV, JARVIS_TRUSTED_PROXY: "not-an-ip" }),
      /JARVIS_TRUSTED_PROXY/,
    );
  });
});

describe("remote gateway request policy", () => {
  const policy = resolveRemoteGatewayConfig(REMOTE_ENV);

  function request(overrides: Partial<RemoteGatewayRequest> = {}): RemoteGatewayRequest {
    return {
      origin: "https://console.example.com",
      forwardedProto: "https",
      contentLength: 128,
      clientKey: "198.51.100.20",
      ...overrides,
    };
  }

  it("allows an allowed HTTPS request under the configured limit", () => {
    assert.deepEqual(evaluateRemoteGatewayRequest(policy, request()), {
      allowed: true,
    });
  });

  it("rejects cleartext, disallowed origins, and oversized requests", () => {
    assert.equal(
      rejection(evaluateRemoteGatewayRequest(policy, request({ forwardedProto: "http" }))),
      "tls-required",
    );
    assert.equal(
      rejection(
        evaluateRemoteGatewayRequest(policy, request({ origin: "https://evil.example.com" })),
      ),
      "origin-not-allowed",
    );
    assert.equal(
      rejection(
        evaluateRemoteGatewayRequest(
          policy,
          request({ contentLength: policy.maxRequestBytes + 1 }),
        ),
      ),
      "request-too-large",
    );
  });

  it("rate-limits a client after the configured window budget", () => {
    const limited = resolveRemoteGatewayConfig({
      ...REMOTE_ENV,
      JARVIS_RATE_LIMIT_MAX_REQUESTS: "1",
      JARVIS_RATE_LIMIT_WINDOW_MS: "1000",
    });
    assert.deepEqual(evaluateRemoteGatewayRequest(limited, request()), {
      allowed: true,
    });
    assert.equal(
      rejection(evaluateRemoteGatewayRequest(limited, request())),
      "rate-limit-exceeded",
    );
  });

  it("keeps attacker-rotated client keys under a hard memory cap", () => {
    const capped = resolveRemoteGatewayConfig(REMOTE_ENV);
    const now = Date.now();
    for (let index = 0; index < 10_000; index += 1) {
      capped.rateBuckets.set(`client-${index}`, { windowStartedAt: now, count: 1 });
    }

    assert.equal(
      rejection(
        evaluateRemoteGatewayRequest(capped, request({ clientKey: "new-attacker-key" }), now),
      ),
      "rate-limit-exceeded",
    );
    assert.equal(capped.rateBuckets.size, 10_000);
  });

  it("prunes expired buckets only when the cap is reached", () => {
    const capped = resolveRemoteGatewayConfig(REMOTE_ENV);
    const now = Date.now();
    for (let index = 0; index < 10_000; index += 1) {
      capped.rateBuckets.set(`expired-${index}`, {
        windowStartedAt: now - capped.rateLimitWindowMs,
        count: 1,
      });
    }

    assert.deepEqual(evaluateRemoteGatewayRequest(capped, request({ clientKey: "new-key" }), now), {
      allowed: true,
    });
    assert.equal(capped.rateBuckets.size, 1);
  });
});

describe("remote gateway trust-proxy boundary (real HTTP request, not just the pure decision function)", () => {
  const TRUSTED_PEER = "203.0.113.10";
  const UNTRUSTED_PEER = "198.51.100.99";

  function minimalPersistence(): PersistenceProvider {
    const forbidden = (): never => {
      throw new Error("must not be reached");
    };
    return {
      async loadState() {
        return {};
      },
      async listTasks() {
        return [];
      },
      async listReminders() {
        return [];
      },
      addTask: forbidden,
      updateTask: forbidden,
      completeTask: forbidden,
      removeTask: forbidden,
      addReminder: forbidden,
      updateReminder: forbidden,
      removeReminder: forbidden,
      saveState: forbidden,
    };
  }

  const openApps: NestFastifyApplication[] = [];
  afterEach(async () => {
    await Promise.all(openApps.splice(0).map((app) => app.close()));
  });

  async function makeGatewayApp(): Promise<NestFastifyApplication> {
    const config: HttpAppConfig = {
      version: "0.1.0",
      sourceVersion: "remote-gateway-trust-boundary-test",
      deploymentVersion: null,
      timezone: "Australia/Melbourne",
      currentToken: "a".repeat(32),
      authMode: "service-token",
      remoteGateway: resolveRemoteGatewayConfig({
        JARVIS_REMOTE_GATEWAY_ENABLED: "true",
        JARVIS_TLS_TERMINATED: "true",
        JARVIS_ALLOWED_ORIGINS: "https://console.example.com",
        JARVIS_TRUSTED_PROXY: TRUSTED_PEER,
      }),
    };
    const app = await createJarvisHttpApp({
      persistence: minimalPersistence(),
      providerName: "json",
      config,
      logger: false,
    });
    openApps.push(app);
    return app;
  }

  it("allows a request forwarded as HTTPS by the configured trusted proxy", async () => {
    const app = await makeGatewayApp();
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: TRUSTED_PEER,
      headers: { "x-forwarded-proto": "https" },
    });
    assert.notEqual(response.statusCode, 400);
  });

  it("rejects a spoofed X-Forwarded-Proto from a direct, untrusted peer -- the exact vulnerability this closes", async () => {
    const app = await makeGatewayApp();
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: UNTRUSTED_PEER,
      headers: { "x-forwarded-proto": "https" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().type, "urn:jarvis:problem:remote-tls-required");
  });

  it("still fails closed when the trusted proxy itself reports a non-HTTPS hop", async () => {
    const app = await makeGatewayApp();
    const withHeader = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: TRUSTED_PEER,
      headers: { "x-forwarded-proto": "http" },
    });
    assert.equal(withHeader.statusCode, 400);

    const withoutHeader = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: TRUSTED_PEER,
    });
    assert.equal(withoutHeader.statusCode, 400);
  });
});
