import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArgumentsHost } from "@nestjs/common";

import type { HttpAppConfig } from "../src/http/config.js";
import {
  JarvisProblem,
  ProblemDetailsFilter,
  redactedRequestPath,
  type ProblemDetails,
} from "../src/http/problemDetails.js";

const BASE_CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "redaction-marker-collision-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "service-token-abcdefghijklmnopqrstuvwxyz0123",
  previousToken: undefined,
  currentApprovalToken: undefined,
  previousApprovalToken: undefined,
};

describe("HTTP secret redaction marker collisions", () => {
  it("does not return the path replacement marker when that marker is a configured credential", () => {
    const secret = "redacted";
    const config = { ...BASE_CONFIG, currentApprovalToken: secret };

    const output = redactedRequestPath(`/before/${secret}/after`, config);

    assert.equal(output.includes(secret), false);
  });

  it("does not return the detail replacement marker when that marker is a configured credential", () => {
    const secret = "[REDACTED]";
    const config = { ...BASE_CONFIG, currentApprovalToken: secret };
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

    new ProblemDetailsFilter(config).catch(
      new JarvisProblem(400, "synthetic", "Synthetic error", `Before ${secret} After`),
      host,
    );

    assert.equal(body?.detail.includes(secret), false);
  });
});
