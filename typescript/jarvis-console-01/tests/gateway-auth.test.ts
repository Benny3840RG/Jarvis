import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decideGatewayAccess } from "../gatewayAuth.js";

describe("Console gateway authentication", () => {
  it("allows only the MCP initialise handshake without configured authentication", () => {
    assert.equal(
      decideGatewayAccess({ rpcMethod: "initialize" }),
      "allow-initialize",
    );
    assert.equal(
      decideGatewayAccess({ rpcMethod: "tools/list" }),
      "missing-configuration",
    );
    assert.equal(
      decideGatewayAccess({ rpcMethod: "tools/call" }),
      "missing-configuration",
    );
    assert.equal(
      decideGatewayAccess({ rpcMethod: "resources/read" }),
      "missing-configuration",
    );
    assert.equal(decideGatewayAccess({}), "missing-configuration");
  });

  it("accepts an exact configured bearer token for protected requests", () => {
    assert.equal(
      decideGatewayAccess({
        configuredToken: "configured-console-token",
        candidateToken: "configured-console-token",
        rpcMethod: "tools/list",
      }),
      "allow-token",
    );
  });

  it("rejects missing, wrong, prefixed and suffixed credentials", () => {
    const configuredToken = "configured-console-token";
    for (const candidateToken of [
      undefined,
      "wrong-console-token",
      `prefix-${configuredToken}`,
      `${configuredToken}-suffix`,
    ]) {
      assert.equal(
        decideGatewayAccess({
          configuredToken,
          candidateToken,
          rpcMethod: "tools/call",
        }),
        "unauthorized",
      );
    }
  });

  it("keeps initialise as a metadata-only exception even when a token is configured", () => {
    assert.equal(
      decideGatewayAccess({
        configuredToken: "configured-console-token",
        rpcMethod: "initialize",
      }),
      "allow-initialize",
    );
  });

  it("integrates the decision into the MCP middleware without relaxing SSE", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

    assert.match(source, /decideGatewayAccess/);
    assert.match(source, /c\.req\.raw\.clone\(\)/);
    assert.match(source, /rpcMethod/);
    assert.match(source, /allow-initialize/);
    assert.match(source, /allow-token/);
    assert.match(source, /missing-configuration/);
    assert.match(source, /path === "\/sse"/);
  });
});
