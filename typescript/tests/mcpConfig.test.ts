import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveJarvisMcpConfig } from "../src/mcp/config.js";

describe("Jarvis MCP preview configuration", () => {
  it("defaults to loopback and the local Jarvis HTTP port", () => {
    const config = resolveJarvisMcpConfig({
      JARVIS_SERVICE_TOKEN: "test-service-token",
      JARVIS_HTTP_PORT: "3210",
    });

    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8787);
    assert.equal(config.api.baseUrl.href, "http://127.0.0.1:3210/");
    assert.equal(config.api.serviceToken, "test-service-token");
  });

  it("requires the service token without exposing it", () => {
    assert.throws(() => resolveJarvisMcpConfig({}), /JARVIS_SERVICE_TOKEN is required/);
    assert.throws(
      () => resolveJarvisMcpConfig({ JARVIS_SERVICE_TOKEN: "bad token" }),
      /must not contain whitespace/,
    );
  });

  it("fails closed for every non-loopback binding", () => {
    assert.throws(
      () =>
        resolveJarvisMcpConfig({
          JARVIS_SERVICE_TOKEN: "test-service-token",
          JARVIS_MCP_HOST: "0.0.0.0",
        }),
      /Remote MCP exposure is disabled/,
    );

    assert.throws(
      () =>
        resolveJarvisMcpConfig({
          JARVIS_SERVICE_TOKEN: "test-service-token",
          JARVIS_MCP_HOST: "0.0.0.0",
          JARVIS_MCP_ALLOW_REMOTE: "true",
        }),
      /Remote MCP exposure is disabled/,
    );
  });

  it("keeps the authenticated Jarvis API origin loopback-only", () => {
    assert.throws(
      () =>
        resolveJarvisMcpConfig({
          JARVIS_SERVICE_TOKEN: "test-service-token",
          JARVIS_API_BASE_URL: "https://api.example.test/jarvis",
        }),
      /Remote Jarvis API access is disabled/,
    );
    assert.throws(
      () =>
        resolveJarvisMcpConfig({
          JARVIS_SERVICE_TOKEN: "test-service-token",
          JARVIS_API_BASE_URL: "http://user:pass@127.0.0.1:3000",
        }),
      /must not include embedded credentials/,
    );

    const config = resolveJarvisMcpConfig({
      JARVIS_SERVICE_TOKEN: "test-service-token",
      JARVIS_API_BASE_URL: "http://localhost:3000/jarvis?ignored=true#ignored",
    });
    assert.equal(config.api.baseUrl.href, "http://localhost:3000/jarvis/");
  });

  it("accepts only absolute HTTP API URLs and valid ports", () => {
    assert.throws(
      () =>
        resolveJarvisMcpConfig({
          JARVIS_SERVICE_TOKEN: "test-service-token",
          JARVIS_API_BASE_URL: "file:///tmp/jarvis",
        }),
      /must use HTTP or HTTPS/,
    );
    assert.throws(
      () =>
        resolveJarvisMcpConfig({
          JARVIS_SERVICE_TOKEN: "test-service-token",
          JARVIS_MCP_PORT: "70000",
        }),
      /between 1 and 65535/,
    );
  });
});
