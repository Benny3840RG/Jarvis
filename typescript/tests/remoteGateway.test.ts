import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateRemoteGatewayRequest,
  resolveRemoteGatewayConfig,
  type RemoteGatewayRequest,
} from "../src/http/remoteGateway.js";
import { resolveHttpAppConfig, resolveHttpListenConfig } from "../src/http/config.js";

const REMOTE_ENV = {
  JARVIS_HTTP_HOST: "0.0.0.0",
  JARVIS_HTTP_PORT: "3000",
  JARVIS_REMOTE_GATEWAY_ENABLED: "true",
  JARVIS_TLS_TERMINATED: "true",
  JARVIS_OIDC_ISSUER: "https://issuer.example.com/",
  JARVIS_OIDC_AUDIENCE: "jarvis-api",
  JARVIS_OIDC_JWKS_URL: "https://issuer.example.com/.well-known/jwks.json",
  JARVIS_ALLOWED_ORIGINS: "https://console.example.com,https://admin.example.com",
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
    assert.deepEqual(config.remoteGateway?.allowedOrigins, [
      "https://console.example.com",
      "https://admin.example.com",
    ]);
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
    assert.deepEqual(evaluateRemoteGatewayRequest(policy, request()), { allowed: true });
  });

  it("rejects cleartext, disallowed origins, and oversized requests", () => {
    assert.equal(evaluateRemoteGatewayRequest(policy, request({ forwardedProto: "http" })).code, "tls-required");
    assert.equal(
      evaluateRemoteGatewayRequest(policy, request({ origin: "https://evil.example.com" })).code,
      "origin-not-allowed",
    );
    assert.equal(
      evaluateRemoteGatewayRequest(policy, request({ contentLength: policy.maxRequestBytes + 1 })).code,
      "request-too-large",
    );
  });

  it("rate-limits a client after the configured window budget", () => {
    const limited = resolveRemoteGatewayConfig({
      ...REMOTE_ENV,
      JARVIS_RATE_LIMIT_MAX_REQUESTS: "1",
      JARVIS_RATE_LIMIT_WINDOW_MS: "1000",
    });
    assert.deepEqual(evaluateRemoteGatewayRequest(limited, request()), { allowed: true });
    assert.equal(evaluateRemoteGatewayRequest(limited, request()).code, "rate-limit-exceeded");
  });
});
