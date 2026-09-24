import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { renderCredentialsPage } from "../src/settings/credentialsPage.js";
import {
  captureCredentials,
  decideEndOverlap,
  deliveryDigestCollides,
  endOverlapControl,
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

  it("does not offer End on idle and does not trust client verify alone", () => {
    const idleControl = endOverlapControl({
      confirmation: END_OVERLAP_PHRASE,
      verify: "idle",
      context: "card",
      attestedPassing: true,
    });
    assert.equal(idleControl.offered, false);
    assert.equal(idleControl.primary, false);
    assert.equal(idleControl.allowed, false);

    const clientOnly = decideEndOverlap({
      tokenId: "delivery",
      confirmation: END_OVERLAP_PHRASE,
      verify: "passing",
      context: "wizard",
    });
    assert.equal(clientOnly.posture, "not-verified");
    assert.equal(clientOnly.offered, false);
    assert.equal(clientOnly.primary, false);
    assert.equal(clientOnly.allowed, false);
    assert.equal(clientOnly.executesRemoval, false);
    assert.deepEqual(clientOnly.commands, []);
    assert.equal(clientOnly.dangerHref, "/settings/danger#delivery");

    const attestedIdle = decideEndOverlap(
      {
        tokenId: "approval",
        confirmation: END_OVERLAP_PHRASE,
        verify: "idle",
        context: "card",
      },
      { attestedPassing: true },
    );
    assert.equal(attestedIdle.posture, "guarding");
    assert.equal(attestedIdle.offered, false);
    assert.equal(attestedIdle.executesRemoval, false);
    assert.deepEqual(attestedIdle.commands, []);
    assert.equal(attestedIdle.dangerHref, "/settings/danger#approval");
  });

  it("does not offer End from client verify and never executes removal", () => {
    const idle = decideEndOverlap(
      {
        tokenId: "service",
        confirmation: END_OVERLAP_PHRASE,
        verify: "idle",
        context: "card",
      },
      { attestedPassing: true },
    );
    const failing = decideEndOverlap({
      tokenId: "service",
      confirmation: END_OVERLAP_PHRASE,
      verify: "failing",
      context: "wizard",
    });
    const passing = decideEndOverlap(
      {
        tokenId: "service",
        confirmation: END_OVERLAP_PHRASE,
        verify: "passing",
        context: "wizard",
      },
      { attestedPassing: false },
    );
    for (const decision of [idle, failing, passing]) {
      assert.equal(decision.offered, false);
      assert.equal(decision.primary, false);
      assert.equal(decision.allowed, false);
      assert.equal(decision.executesRemoval, false);
      assert.deepEqual(decision.commands, []);
      assert.equal(decision.dangerHref, "/settings/danger#service");
    }
    assert.equal(idle.posture, "guarding");
    assert.equal(failing.posture, "not-verified");
    assert.equal(passing.posture, "not-verified");
    assert.equal(
      decideEndOverlap(
        {
          tokenId: "approval",
          confirmation: END_OVERLAP_PHRASE,
          verify: "passing",
          context: "card",
        },
        { attestedPassing: false },
      ).dangerHref,
      "/settings/danger#approval",
    );
    const attested = decideEndOverlap(
      {
        tokenId: "service",
        confirmation: END_OVERLAP_PHRASE,
        verify: "passing",
        context: "wizard",
      },
      { attestedPassing: true },
    );
    assert.equal(attested.posture, "guarding");
    assert.equal(attested.offered, false);
    assert.equal(attested.executesRemoval, false);
    assert.deepEqual(attested.commands, []);
    assert.equal(
      parseEndOverlapRequest({
        tokenId: "service",
        confirmation: SERVICE,
        verify: "passing",
        context: "wizard",
        attestedPassing: true,
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
  it("keeps digests and End overlap out of the loopback page", () => {
    const captured = runtime();
    const html = renderCredentialsPage(captured.pageModel);
    assert.equal("serviceDigests" in captured.pageModel, false);
    assertNoSecret(html, [SERVICE, APPROVAL, DELIVERY, PREVIOUS]);
    assert.match(html, /Generate new token/);
    assert.match(html, /connect-src 'none'/);
    assert.doesNotMatch(
      html,
      /serviceDigests|END OVERLAP|openEnd\(|end-dialog|endOverlapCommands|Smoke passed|<span class="tab">/,
    );
    assert.doesNotMatch(html, /[0-9a-f]{64}/);
    assert.equal(html.includes(secretDigest(SERVICE)), false);
    assert.equal(html.includes(secretDigest(PREVIOUS)), false);
    assert.match(html, /fp-chip/);
    assert.match(html, /href="\/settings\/danger#service"/);
    assert.match(html, /href="\/settings\/danger#approval"/);
    assert.match(html, /href="\/settings\/danger#delivery"/);
    assert.match(html, /"\/settings\/danger#" \+ card\.id/);
    assert.match(html, /"\/settings\/danger#" \+ flowId/);
    const embedded = html.match(/id="credentials-model">([^<]*)<\/script>/);
    assert.ok(embedded?.[1]);
    const pageModel = JSON.parse(embedded[1]) as { status?: unknown; serviceDigests?: unknown };
    assert.equal("serviceDigests" in pageModel, false);
    assert.equal(JSON.stringify(pageModel).includes(secretDigest(SERVICE)), false);
    assert.match(html, /href="#settings-general"/);
    assert.match(html, /href="#settings-persistence"/);
    assert.match(html, /id="settings-general"/);
    assert.match(html, /id="settings-persistence"/);
    assert.match(html, /does not remove the previous token/);
    assert.match(html, /Not verified/);
    assert.match(html, /Idle has no End button/);
    assert.match(html, /Guarding is shown only after this server attests/);
    assert.match(html, /still does not offer End/);
    assert.doesNotMatch(html, /<button[^>]*>\s*End\b/);
    assert.match(html, /min-height:44px/);
    assert.match(html, /font-size:14px; font-weight:600/);
    assert.match(html, /font-size:16px/);
    assert.match(html, /prefers-reduced-motion:\s*reduce/);
    assert.doesNotMatch(html, /#39ff88|#b933ff|#ff2fbf|#39e6ff/i);
    assert.doesNotMatch(html, /stays hidden while verification is failing|hidden until smoke/);
    assert.doesNotMatch(
      html,
      /localStorage|sessionStorage|Expose to LAN|npx convex env set [A-Za-z0-9]{16}|npx convex env remove/,
    );
    assert.match(html, /127\.0\.0\.1:3000/);
    assert.match(html, /Blocked \(fail closed\)/);
  });

  it("keeps the MCP widget on status and runbook links", () => {
    const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");
    const start = widget.indexOf('id="view-credentials"');
    const end = widget.indexOf('id="view-persistence"');
    assert.ok(start !== -1 && end > start, "Credentials view was not found");
    const credentialsView = widget.slice(start, end);
    assert.match(widget, /data-view="settings"/);
    assert.doesNotMatch(widget, /data-view="credentials"|data-view="general"/);
    assert.match(credentialsView, /does not generate secrets/);
    assert.match(credentialsView, /Not verified/);
    assert.match(credentialsView, /Guarding still has no End button/);
    assert.doesNotMatch(credentialsView, /<button[^>]*>\s*End\b/);
    assert.match(widget, /does not mint secrets/);
    assert.match(widget, /href="\/settings\/danger#service"/);
    assert.match(widget, /href="\/settings\/danger#approval"/);
    assert.match(widget, /href="\/settings\/danger#delivery"/);
    const pageSource = readFileSync(
      new URL("../src/settings/credentialsPage.ts", import.meta.url),
      "utf8",
    );
    const statusSource = readFileSync(
      new URL("../src/settings/credentialsStatus.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      pageSource,
      /function openEnd|id="end-dialog"|endOverlapCommands|openEnd\(/,
    );
    assert.doesNotMatch(statusSource, /function endOverlapCommands/);
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
