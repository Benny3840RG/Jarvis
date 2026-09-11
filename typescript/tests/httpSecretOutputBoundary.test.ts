import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { ArgumentsHost } from "@nestjs/common";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import {
  configuredSecrets,
  redactedRequestPath,
  JarvisProblem,
  ProblemDetailsFilter,
  type ProblemDetails,
} from "../src/http/problemDetails.js";
import { resolveRemoteGatewayConfig } from "../src/http/remoteGateway.js";
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

async function makeApp(
  config: HttpAppConfig = CONFIG,
  persistence: PersistenceProvider = minimalPersistence(),
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence,
    providerName: "json",
    config,
    logger: false,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("HTTP secret output boundary", () => {
  it("matches UTF-8, control and literal metacharacter credentials without altering other bytes", () => {
    for (const secret of [
      "credential-é-🌳-abcdefghijklmnopqrstuvwxyz",
      "credential-\u0000-abcdefghijklmnopqrstuvwxyz",
      "credential-.*+$[](){}-abcdefghijklmnopqrstuvwxyz",
    ]) {
      const config = { ...CONFIG, currentApprovalToken: secret };
      for (const form of [
        secret,
        encodeURIComponent(secret),
        encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (byte) => byte.toLowerCase()),
      ]) {
        assert.equal(
          redactedRequestPath(`/before%20/${form}/after%2f`, config),
          "/before%20/redacted/after%2f",
        );
      }
    }
  });

  it("suppresses output when credential or field length exceeds the work budget", () => {
    assert.equal(
      redactedRequestPath("/ordinary", { ...CONFIG, currentToken: "x".repeat(100001) }),
      "redacted",
    );
    assert.equal(redactedRequestPath("/" + "x".repeat(100001), CONFIG), "redacted");
  });

  it("preserves unrelated path bytes while matching literal and encoded percent credentials", () => {
    const secret = "percent%25-credential-abcdefghijklmnopqrstuvwxyz";
    const config = { ...CONFIG, currentApprovalToken: secret };
    for (const form of [
      secret,
      encodeURIComponent(secret),
      secret.replace("credential", "%63redential"),
    ]) {
      assert.equal(
        redactedRequestPath(`/keep%20this/${form}/also%2Fkeep`, config),
        "/keep%20this/redacted/also%2Fkeep",
      );
    }
    assert.equal(redactedRequestPath("/ordinary%20path/bad%zz", config), "/ordinary%20path/bad%zz");
  });
  it("bounds work for long percent-containing credentials in a timed subprocess", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { redactedRequestPath } from './src/http/problemDetails.ts';
      const secret = '%25'.repeat(1000) + 'Z';
      const input = '/' + '%25'.repeat(10000) + 'Y';
      const started = performance.now();
      const output = redactedRequestPath(input, { currentApprovalToken: secret });
      console.log(JSON.stringify({ elapsed: performance.now() - started, output }));
    `,
      ],
      { cwd: process.cwd(), timeout: 10000, encoding: "utf8" },
    );
    const result = JSON.parse(output) as { elapsed: number; output: string };
    assert.equal(result.output, "redacted");
  });
  it("rejects request ids containing credentials as substrings", async () => {
    const app = await makeApp();
    for (const secret of ALL_SECRETS) {
      const candidate = `trace-${secret}-retry`;
      assert.notEqual(resolveRequestId(candidate, configuredSecrets(CONFIG)), candidate);
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { "x-request-id": candidate },
      });
      assert.ok(!JSON.stringify(response.headers).includes(secret));
      assert.ok(!response.body.includes(secret));
    }
  });

  it("redacts every configured credential in explicit safe problem details", () => {
    let body: ProblemDetails | undefined;
    const response = {
      header: () => response,
      status: () => response,
      type: () => response,
      send: (value: ProblemDetails) => {
        body = value;
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: "/api/v1/tasks", id: "synthetic-request" }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    new ProblemDetailsFilter(CONFIG).catch(
      new JarvisProblem(
        400,
        "synthetic",
        "Synthetic error",
        `Before\n${ALL_SECRETS.join(" | ")}\nAfter`,
      ),
      host,
    );
    assert.equal(body?.detail, `Before\n${ALL_SECRETS.map(() => "[REDACTED]").join(" | ")}\nAfter`);
  });

  it("ignores empty configured credentials without corrupting ordinary problem output", async () => {
    const config = { ...CONFIG, currentApprovalToken: "", previousApprovalToken: "" };
    assert.ok(!configuredSecrets(config).includes(""));
    const app = await makeApp(config);
    const response = await app.inject({ method: "GET", url: "/api/v1/status" });
    assert.equal(response.json().detail, "A valid Bearer service token is required.");
    assert.equal(response.json().instance, "/api/v1/status");
  });

  it("redacts fully and partially percent-encoded credentials in paths", async () => {
    const secret = "approval/credential+with-reserved-characters123";
    const app = await makeApp({ ...CONFIG, currentApprovalToken: secret });
    const encoded = [...Buffer.from(secret)].map((byte) => `%${byte.toString(16)}`).join("");
    for (const form of [
      encodeURIComponent(secret),
      encoded,
      encoded.toUpperCase(),
      secret.replaceAll("/", "%2f"),
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/${form}/missing`,
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      });
      assert.equal(response.json().instance, "/api/v1/redacted/missing");
    }
  });

  it("redacts credentials when the remote gateway rejects before the Nest filter", async () => {
    const remoteGateway = resolveRemoteGatewayConfig({
      JARVIS_REMOTE_GATEWAY_ENABLED: "true",
      JARVIS_TLS_TERMINATED: "true",
      JARVIS_ALLOWED_ORIGINS: "https://allowed.example.com",
    });
    const app = await makeApp({ ...CONFIG, remoteGateway });
    for (const secret of ALL_SECRETS) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/${secret}/missing`,
        headers: { origin: "https://rejected.example.com", "x-forwarded-proto": "https" },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().instance, "/api/v1/redacted/missing");
      assert.ok(!response.body.includes(secret));
    }
  });

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
