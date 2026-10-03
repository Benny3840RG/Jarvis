import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Reflector } from "@nestjs/core";

import { ServiceTokenGuard } from "../src/http/serviceTokenGuard.js";
import type { HttpAppConfig } from "../src/http/config.js";
import {
  getAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
} from "../src/http/authenticatedPrincipal.js";
import type { CredentialsRuntime } from "../src/settings/credentialsStatus.js";

// These cases exercise the OIDC path on unflagged routes, so serveLocalPage is
// irrelevant; a non-local stub keeps the loopback bypass out of the way.
const nonLocalCredentials = { serveLocalPage: false } as unknown as CredentialsRuntime;

function requestContext(request: Record<string, unknown>) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

function config(subject = "owner-subject"): HttpAppConfig {
  return {
    version: "0.1.0",
    sourceVersion: "development",
    deploymentVersion: null,
    authMode: "oidc",
    oidc: {
      issuer: "https://issuer.example.com/",
      audience: "jarvis-api",
      jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
      clockSkewSeconds: 30,
      subject,
    },
  };
}

function oidcVerifier(subject: string) {
  return {
    verify: async () => ({
      subject,
      issuer: "https://issuer.example.com/",
      audience: "jarvis-api",
    }),
  };
}

describe("authenticated HTTP principal context", () => {
  it("stores the verified OIDC identity as an immutable request principal", async () => {
    const request = {
      headers: { authorization: "Bearer verified-token" },
      ip: "127.0.0.1",
    };
    const guard = new ServiceTokenGuard(
      new Reflector(),
      config(),
      oidcVerifier("owner-subject"),
      nonLocalCredentials,
    );

    assert.equal(await guard.canActivate(requestContext(request)), true);

    const principal = getAuthenticatedPrincipal(request) as AuthenticatedPrincipal;
    assert.deepEqual(principal, {
      kind: "oidc",
      subject: "owner-subject",
      issuer: "https://issuer.example.com/",
      audience: "jarvis-api",
    });
    assert.equal(Object.isFrozen(principal), true);
    assert.equal(Reflect.set(principal as object, "subject", "attacker"), false);
    assert.equal(getAuthenticatedPrincipal(request)?.subject, "owner-subject");
  });

  it("does not create a principal when the verified subject is not authorised", async () => {
    const request = {
      headers: { authorization: "Bearer verified-token" },
      ip: "127.0.0.1",
    };
    const guard = new ServiceTokenGuard(
      new Reflector(),
      config(),
      oidcVerifier("other-subject"),
      nonLocalCredentials,
    );

    await assert.rejects(
      () => guard.canActivate(requestContext(request)),
      /authorised for this Jarvis owner/,
    );
    assert.equal(getAuthenticatedPrincipal(request), undefined);
  });
});
