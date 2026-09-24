import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import {
  FailClosedRateLimitStore,
  resolveHttpRateLimitConfig,
  type HttpRateLimitConfig,
} from "../src/http/httpRateLimit.js";
import { resolveRemoteGatewayConfig } from "../src/http/remoteGateway.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: forbidden,
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "http-rate-limit-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "a".repeat(32),
};

const openApps: NestFastifyApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function makeApp(
  options: {
    config?: HttpAppConfig;
    httpRateLimit?: HttpRateLimitConfig;
  } = {},
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: unusedPersistence(),
    providerName: "json",
    config: options.config ?? CONFIG,
    httpRateLimit: options.httpRateLimit,
    logger: false,
  });
  openApps.push(app);
  return app;
}

describe("HTTP rate limit configuration", () => {
  it("uses a generous loopback default and fails closed on an invalid budget", () => {
    assert.deepEqual(resolveHttpRateLimitConfig({}), { max: 1_000, timeWindowMs: 60_000 });
    assert.throws(
      () => resolveHttpRateLimitConfig({ JARVIS_HTTP_RATE_LIMIT_MAX: "0" }),
      /JARVIS_HTTP_RATE_LIMIT_MAX/,
    );
    assert.throws(
      () => resolveHttpRateLimitConfig({ JARVIS_HTTP_RATE_LIMIT_WINDOW_MS: "soon" }),
      /JARVIS_HTTP_RATE_LIMIT_WINDOW_MS/,
    );
  });

  it("uses the remote gateway budget as the single HTTP counter", () => {
    const remoteGateway = resolveRemoteGatewayConfig({
      JARVIS_REMOTE_GATEWAY_ENABLED: "true",
      JARVIS_TLS_TERMINATED: "true",
      JARVIS_ALLOWED_ORIGINS: "https://console.example.com",
      JARVIS_TRUSTED_PROXY: "203.0.113.10",
      JARVIS_RATE_LIMIT_MAX_REQUESTS: "2",
      JARVIS_RATE_LIMIT_WINDOW_MS: "5000",
    });
    assert.deepEqual(
      resolveHttpRateLimitConfig({ JARVIS_HTTP_RATE_LIMIT_MAX: "9" }, remoteGateway),
      { max: 2, timeWindowMs: 5_000 },
    );
  });
});

describe("HTTP edge rate limit", () => {
  it("returns 429 and Retry-After after the configured budget", async () => {
    const app = await makeApp({ httpRateLimit: { max: 2, timeWindowMs: 60_000 } });

    const first = await app.inject({ method: "GET", url: "/healthz" });
    const second = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);

    const limited = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(limited.statusCode, 429);
    assert.match(limited.headers["content-type"] ?? "", /application\/problem\+json/);
    const retryAfter = Number(limited.headers["retry-after"]);
    assert.equal(Number.isInteger(retryAfter), true);
    assert.ok(retryAfter >= 1);
    const body = limited.json();
    assert.equal(body.type, "urn:jarvis:problem:rate-limit-exceeded");
    assert.equal(body.status, 429);
    assert.equal(body.title, "Too Many Requests");
    assert.equal(typeof body.requestId, "string");
    assert.ok(body.requestId.length >= 8);
  });

  it("does not also apply the remote gateway bucket counter", async () => {
    const remoteGateway = resolveRemoteGatewayConfig({
      JARVIS_REMOTE_GATEWAY_ENABLED: "true",
      JARVIS_TLS_TERMINATED: "true",
      JARVIS_ALLOWED_ORIGINS: "https://console.example.com",
      JARVIS_TRUSTED_PROXY: "203.0.113.10",
      JARVIS_RATE_LIMIT_MAX_REQUESTS: "1",
      JARVIS_RATE_LIMIT_WINDOW_MS: "60000",
    });
    const app = await makeApp({
      config: {
        ...CONFIG,
        remoteGateway,
      },
    });

    const allowed = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: "203.0.113.10",
      headers: { "x-forwarded-proto": "https" },
    });
    assert.equal(allowed.statusCode, 200);

    const limited = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: "203.0.113.10",
      headers: { "x-forwarded-proto": "https" },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().type, "urn:jarvis:problem:rate-limit-exceeded");
    const retryAfter = Number(limited.headers["retry-after"]);
    assert.equal(Number.isInteger(retryAfter), true);
    assert.ok(retryAfter >= 1);
  });

  it("rejects a new client when every live key slot is in use", async () => {
    const app = await makeApp({
      httpRateLimit: { max: 5, timeWindowMs: 60_000, maxKeys: 1 },
    });
    const first = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: "198.51.100.1",
    });
    const rotated = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: "198.51.100.2",
    });
    assert.equal(first.statusCode, 200);
    assert.equal(rotated.statusCode, 429);
    assert.equal(rotated.json().type, "urn:jarvis:problem:rate-limit-exceeded");
    assert.ok(Number(rotated.headers["retry-after"]) >= 1);
  });
});

describe("fail-closed HTTP rate-limit store", () => {
  it("reclaims an expired key before rejecting a new client", () => {
    let now = 1_000;
    const store = new FailClosedRateLimitStore({ cache: 1 }, () => now);
    store.incr("old", () => undefined, 1_000, 5);
    now = 2_000;
    let admitted = 0;
    store.incr(
      "new",
      (_error, result) => {
        admitted = result?.current ?? 0;
      },
      1_000,
      5,
    );
    assert.equal(admitted, 1);
  });
});
