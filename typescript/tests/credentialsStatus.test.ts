import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { renderCredentialsPage } from "../src/settings/credentialsPage.js";
import {
  captureCredentials,
  decideEndOverlap,
  deliveryDigestCollides,
  END_OVERLAP_PHRASE,
  fingerprintSecret,
  parseDeliveryCheckRequest,
  parseEndOverlapRequest,
  secretDigest,
  selectCredentialsRuntime,
} from "../src/settings/credentialsStatus.js";
import { MCP_TOOL_OPERATIONS } from "../src/mcp/operationContract.js";

const SERVICE = "service-token-value-0123456789abcdef-EXTRA";
const APPROVAL = "approval-token-value-0123456789abcdef-EXTRA";
const DELIVERY = "delivery-token-value-0123456789abcdef-EXTRA";
const PREVIOUS = "previous-service-token-0123456789abcdef-EXTRA";

function runtime() {
  return captureCredentials({
    serviceToken: SERVICE,
    serviceTokenPrevious: PREVIOUS,
    approvalToken: APPROVAL,
    deliveryToken: DELIVERY,
    httpHost: "127.0.0.1",
    httpPort: 3000,
    mcpHost: "127.0.0.1",
    mcpPort: 8787,
    remoteGatewayEnabled: false,
    tlsTerminated: false,
    oidcConfigured: false,
    originsConfigured: false,
    persistenceProvider: "json",
  });
}

function assertNoSecret(serialized: string, secrets: string[]): void {
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false);
  }
}

describe("credential fingerprints", () => {
  it("returns a prefix fingerprint and omits the raw token and full digest", () => {
    const captured = runtime();
    const service = captured.status.tokens[0];
    assert.equal(service?.id, "service");
    assert.equal(service?.configured, true);
    assert.equal(service?.overlapActive, true);
    assert.equal(service?.owner, "jarvis-cli");
    assert.match(service?.fingerprint ?? "", /^[0-9a-f]{4}\u2026[0-9a-f]{4}$/);
    assert.equal(fingerprintSecret(SERVICE), service?.fingerprint);
    const serialized = JSON.stringify(captured.status);
    assertNoSecret(serialized, [SERVICE, APPROVAL, DELIVERY, PREVIOUS, secretDigest(SERVICE)]);
    assert.equal(serialized.includes(secretDigest(DELIVERY)), false);
  });

  it("fail-closes when the service token is missing and warns when approval is missing", () => {
    const captured = captureCredentials({
      httpHost: "127.0.0.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "convex",
    });
    assert.equal(captured.status.failClosed, true);
    assert.match(captured.status.banner ?? "", /fail-closed/);
    assert.equal(captured.status.approvalsWarning, "Approvals unavailable.");
    assert.equal(captured.status.tokens[1]?.warning, "Approvals unavailable.");
    assert.equal(captured.status.tokens[2]?.configured, false);
    assert.match(captured.status.tokens[2]?.statusLabel ?? "", /Not configured/);
    assert.equal(captured.status.bind.loopbackOnly, true);
    assert.equal(captured.status.bind.remoteLabel, "Blocked (fail closed)");
    assert.equal(captured.status.exposure.remoteHttp, "off");
  });

  it("refuses a delivery token that matches the current or previous service token", () => {
    const current = captureCredentials({
      serviceToken: SERVICE,
      deliveryToken: SERVICE,
      httpHost: "127.0.0.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    });
    assert.equal(current.status.tokens[2]?.equalsServiceToken, true);
    assert.match(current.status.tokens[2]?.warning ?? "", /Must differ from the service token/);
    const previous = captureCredentials({
      serviceToken: SERVICE,
      serviceTokenPrevious: PREVIOUS,
      deliveryToken: PREVIOUS,
      httpHost: "127.0.0.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    });
    assert.equal(previous.status.tokens[2]?.equalsServiceToken, true);
    assert.equal(deliveryDigestCollides(secretDigest(SERVICE), current.serviceDigests), true);
    assert.equal(deliveryDigestCollides(secretDigest(DELIVERY), current.serviceDigests), false);
    assert.equal(parseDeliveryCheckRequest({ digestSha256: SERVICE }).ok, false);
    assert.equal(parseDeliveryCheckRequest({ digestSha256: secretDigest(SERVICE) }).ok, true);
  });

  it("returns CLI text for a matching phrase and ignores caller verify state", () => {
    const commands = [
      "npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS",
      "Remove JARVIS_SERVICE_TOKEN_PREVIOUS from .env.local if it is set, then chmod 600 .env.local",
    ];
    const idle = decideEndOverlap({
      tokenId: "service",
      confirmation: END_OVERLAP_PHRASE,
      verify: "idle",
      context: "card",
    });
    const failing = decideEndOverlap({
      tokenId: "service",
      confirmation: END_OVERLAP_PHRASE,
      verify: "failing",
      context: "wizard",
    });
    const passing = decideEndOverlap({
      tokenId: "service",
      confirmation: END_OVERLAP_PHRASE,
      verify: "passing",
      context: "wizard",
    });
    for (const decision of [idle, failing, passing]) {
      assert.equal(decision.offered, true);
      assert.equal(decision.primary, false);
      assert.equal(decision.allowed, true);
      assert.equal(decision.executesRemoval, false);
      assert.deepEqual(decision.commands, commands);
    }
    const wrong = decideEndOverlap({
      tokenId: "service",
      confirmation: SERVICE,
      verify: "passing",
      context: "wizard",
    });
    assert.equal(wrong.allowed, false);
    assert.equal(wrong.primary, false);
    assert.equal(wrong.executesRemoval, false);
    assert.deepEqual(wrong.commands, []);
    assert.equal(
      parseEndOverlapRequest({
        tokenId: "service",
        confirmation: SERVICE,
        verify: "passing",
        context: "wizard",
      }).ok,
      false,
    );
  });

  it("reads delivery from the environment instead of an HttpAppConfig", () => {
    const fromEnv = selectCredentialsRuntime(undefined, {
      JARVIS_SERVICE_TOKEN: SERVICE,
      JARVIS_DELIVERY_RUNTIME_TOKEN: DELIVERY,
      JARVIS_HTTP_HOST: "127.0.0.1",
    });
    assert.equal(fromEnv.status.tokens[2]?.configured, true);
    assert.equal(fromEnv.status.tokens[2]?.fingerprint, fingerprintSecret(DELIVERY));
    assert.equal(fromEnv.serviceDigests.includes(secretDigest(SERVICE)), true);
    const injected = runtime();
    assert.equal(
      selectCredentialsRuntime(injected, { JARVIS_DELIVERY_RUNTIME_TOKEN: "other-delivery-token" }),
      injected,
    );
  });

  it("keeps remote exposure fail-closed unless TLS, OIDC, and origins are all set", () => {
    const blocked = captureCredentials({
      serviceToken: SERVICE,
      httpHost: "10.1.1.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: true,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    });
    assert.equal(blocked.serveLocalPage, false);
    assert.equal(blocked.status.generation, "unavailable");
    assert.equal(blocked.status.localPage, null);
    assert.equal(blocked.status.bind.remoteLabel, "Blocked (fail closed)");
    assert.equal(blocked.status.exposure.mode, "Remote");
    const configured = captureCredentials({
      serviceToken: SERVICE,
      httpHost: "10.1.1.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: true,
      tlsTerminated: true,
      oidcConfigured: true,
      originsConfigured: true,
      persistenceProvider: "json",
    });
    assert.equal(configured.status.bind.remoteLabel, "Configured");
    assert.equal(configured.status.exposure.remoteHttp, "configured");
    assert.equal(configured.status.bind.httpAuth, "OIDC access token");
  });
});

describe("credentials page and MCP surface", () => {
  it("reveals no secret in the loopback page and gates end overlap in the page script", () => {
    const captured = runtime();
    const html = renderCredentialsPage(captured.pageModel);
    assertNoSecret(html, [SERVICE, APPROVAL, DELIVERY, PREVIOUS]);
    assert.match(html, /Generate new token/);
    assert.match(html, /END OVERLAP/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, new RegExp(secretDigest(SERVICE)));
    assert.match(html, new RegExp(secretDigest(PREVIOUS)));
    assert.equal(html.includes(secretDigest(DELIVERY)), false);
    assert.match(html, /does not remove the previous token/);
    assert.match(html, /Danger zone is not this page/);
    assert.doesNotMatch(html, /stays hidden while verification is failing|hidden until smoke/);
    assert.doesNotMatch(
      html,
      /localStorage|sessionStorage|Expose to LAN|npx convex env set [A-Za-z0-9]{16}/,
    );
    assert.match(html, /127\.0\.0\.1:3000/);
    assert.match(html, /Blocked \(fail closed\)/);
    const match = html.match(
      /function endOverlapControl\(confirmation, verify, context\) \{[\s\S]*?\n {4}\}/,
    );
    assert.ok(match);
    const endOverlapControl = new Function(`${match[0]}; return endOverlapControl;`)() as (
      confirmation: string,
      verify: string,
      context: string,
    ) => { offered: boolean; primary: boolean; allowed: boolean; executesRemoval: boolean };
    const idleCard = endOverlapControl(END_OVERLAP_PHRASE, "idle", "card");
    const failingWizard = endOverlapControl(END_OVERLAP_PHRASE, "failing", "wizard");
    const passingWizard = endOverlapControl(END_OVERLAP_PHRASE, "passing", "wizard");
    for (const decision of [idleCard, failingWizard, passingWizard]) {
      assert.equal(decision.primary, false);
      assert.equal(decision.allowed, true);
      assert.equal(decision.executesRemoval, false);
    }
    assert.equal(endOverlapControl("nope", "passing", "wizard").allowed, false);
    assert.equal(endOverlapControl("nope", "idle", "card").allowed, false);
  });

  it("keeps the MCP widget on status and runbook links", () => {
    const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");
    const start = widget.indexOf('id="view-credentials"');
    const end = widget.indexOf('id="view-systems"');
    assert.ok(start !== -1 && end > start, "Credentials view was not found");
    const credentialsView = widget.slice(start, end);
    assert.match(widget, /data-view="credentials"/);
    assert.match(credentialsView, /does not generate secrets/);
    assert.match(widget, /does not mint secrets/);
    assert.doesNotMatch(
      credentialsView,
      /Generate new token|crypto\.getRandomValues|localStorage|sessionStorage|npx convex env set/,
    );
    assert.doesNotMatch(widget, /Generate new token|crypto\.getRandomValues|sessionStorage/);
    const storageUses = [...widget.matchAll(/localStorage/g)];
    assert.equal(storageUses.length, 3);
    for (const match of storageUses) {
      const around = widget.slice(Math.max(0, (match.index ?? 0) - 120), (match.index ?? 0) + 20);
      assert.match(
        around,
        /readConsoleDisplayPreferences\(localStorage|writeConsoleDisplayPreferences\(localStorage/,
      );
    }
    assert.equal(
      Object.keys(MCP_TOOL_OPERATIONS).some((name) => /generate|rotate|secret/i.test(name)),
      false,
    );
  });
});
