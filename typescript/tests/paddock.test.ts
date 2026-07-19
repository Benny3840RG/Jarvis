import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReadlineAdapter } from "../src/cli.js";
import { NonBlankReadline } from "../src/cli/nonBlankReadline.js";
import type { SystemStatus } from "../src/http/contracts.js";
import { resolvePreviewEnvironment } from "../src/preview/environment.js";
import {
  AUTHORISED_DEVELOPMENT_DEPLOYMENT,
  assertPaddockStatus,
  resolvePaddockConfig,
} from "../src/preview/paddock.js";

const validEnvironment: NodeJS.ProcessEnv = {
  PERSISTENCE_PROVIDER: "convex",
  CONVEX_URL: "https://outgoing-ram-798.convex.cloud",
  CONVEX_DEPLOYMENT: AUTHORISED_DEVELOPMENT_DEPLOYMENT,
  JARVIS_SERVICE_TOKEN: "test-service-token",
  OPENAI_API_KEY: "test-openai-key",
};

function healthyStatus(deployment = AUTHORISED_DEVELOPMENT_DEPLOYMENT): SystemStatus {
  return {
    status: "ok",
    version: "0.1.0",
    sourceVersion: "development",
    provider: {
      name: "convex",
      reachability: "ok",
      authentication: "ok",
      schemaCompatibility: "compatible",
      deploymentVersion: deployment,
    },
    timezone: "Australia/Melbourne",
    layers: {},
    zState: "disabled",
    checkedAt: new Date(0).toISOString(),
  } as SystemStatus;
}

class ScriptedReadline implements ReadlineAdapter {
  closed = false;

  constructor(private readonly values: string[]) {}

  async question(): Promise<string> {
    return this.values.shift() ?? "exit";
  }

  close(): void {
    this.closed = true;
  }
}

describe("Jarvis development paddock", () => {
  it("derives the status deployment identity from the authorised Convex deployment", () => {
    const environment = resolvePreviewEnvironment(validEnvironment);
    assert.equal(environment.JARVIS_DEPLOYMENT_VERSION, AUTHORISED_DEVELOPMENT_DEPLOYMENT);

    const config = resolvePaddockConfig(validEnvironment);
    assert.equal(config.deployment, AUTHORISED_DEVELOPMENT_DEPLOYMENT);
    assert.equal(config.environment.JARVIS_DEPLOYMENT_VERSION, AUTHORISED_DEVELOPMENT_DEPLOYMENT);
    assert.equal(config.httpUrl.toString(), "http://127.0.0.1:3000/");
    assert.equal(config.mcpUrl.toString(), "http://127.0.0.1:8787/mcp");
  });

  it("fails closed for non-Convex or unauthorised deployment configuration", () => {
    assert.throws(
      () =>
        resolvePaddockConfig({
          ...validEnvironment,
          PERSISTENCE_PROVIDER: "json",
        }),
      /must be convex/,
    );
    assert.throws(
      () =>
        resolvePaddockConfig({
          ...validEnvironment,
          CONVEX_DEPLOYMENT: "prod:jarvis",
        }),
      /production is not authorised/,
    );
    assert.throws(
      () =>
        resolvePaddockConfig({
          ...validEnvironment,
          JARVIS_DEPLOYMENT_VERSION: "dev:different",
        }),
      /must match CONVEX_DEPLOYMENT/,
    );
  });

  it("accepts only the commissioned Convex provider state", () => {
    assert.doesNotThrow(() =>
      assertPaddockStatus(healthyStatus(), AUTHORISED_DEVELOPMENT_DEPLOYMENT),
    );
    assert.throws(
      () => assertPaddockStatus(healthyStatus("dev:different"), AUTHORISED_DEVELOPMENT_DEPLOYMENT),
      /reported deployment/,
    );
  });

  it("ignores empty interactive prompts before returning a command", async () => {
    const delegate = new ScriptedReadline(["", "   ", "status"]);
    const readline = new NonBlankReadline(delegate);

    assert.equal(await readline.question("You: "), "status");
    readline.close();
    assert.equal(delegate.closed, true);
  });
});
