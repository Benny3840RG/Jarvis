import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import { configuredSecrets } from "../src/http/problemDetails.js";
import { resolveRequestId } from "../src/http/requestId.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

const SERVICE_TOKEN = "service-token-abcdefghijklmnopqrstuvwxyz0123";
const PREVIOUS_SERVICE_TOKEN = "previous-service-token-abcdefghijklmnop01";
const APPROVAL_TOKEN = "approval-token-abcdefghijklmnopqrstuvwxyz01";
const PREVIOUS_APPROVAL_TOKEN = "previous-approval-token-abcdefghijklmn0123";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "secret-output-boundary-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: SERVICE_TOKEN,
  previousToken: PREVIOUS_SERVICE_TOKEN,
  currentApprovalToken: APPROVAL_TOKEN,
  previousApprovalToken: PREVIOUS_APPROVAL_TOKEN,
};

const ALL_SECRETS = [
  SERVICE_TOKEN,
  PREVIOUS_SERVICE_TOKEN,
  APPROVAL_TOKEN,
  PREVIOUS_APPROVAL_TOKEN,
] as const;

const openApps: NestFastifyApplication[] = [];

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

async function makeApp(): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: minimalPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("HTTP secret output boundary", () => {
  it("lists every configured bearer credential, not just the service tokens", () => {
    const secrets = configuredSecrets(CONFIG);
    for (const secret of ALL_SECRETS) {
      assert.ok(secrets.includes(secret), `${secret.slice(0, 12)}… must be covered by redaction`);
    }
  });

  it("never echoes a configured credential supplied as X-Request-Id", async () => {
    const app = await makeApp();
    for (const secret of ALL_SECRETS) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { "x-request-id": secret },
      });
      const echoed = response.headers["x-request-id"];
      assert.notEqual(
        echoed,
        secret,
        `a caller-supplied ${secret.slice(0, 12)}… must not become the request id`,
      );
      assert.equal(
        JSON.stringify(response.json()).includes(secret),
        false,
        "no configured credential may appear in the response body",
      );
    }
  });

  it("rejects every configured credential at the resolveRequestId boundary directly", () => {
    for (const secret of ALL_SECRETS) {
      assert.notEqual(resolveRequestId(secret, configuredSecrets(CONFIG)), secret);
    }
    // A benign id that is not a credential is still honoured.
    assert.equal(resolveRequestId("req-12345678", configuredSecrets(CONFIG)), "req-12345678");
  });

  it("redacts a configured credential out of a problem-details path", async () => {
    const app = await makeApp();
    for (const secret of ALL_SECRETS) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/${secret}/missing`,
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      });
      const body = JSON.stringify(response.json());
      assert.equal(
        body.includes(secret),
        false,
        `${secret.slice(0, 12)}… must not survive into a problem-details response`,
      );
    }
  });
});
