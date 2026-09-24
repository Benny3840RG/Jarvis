import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import { renderDangerZonePage } from "../src/settings/dangerZone/page.js";
import { buildDangerZoneModel } from "../src/settings/dangerZone/catalog.js";
import { renderCredentialsPage } from "../src/settings/credentialsPage.js";
import { captureCredentials, type CredentialsRuntime } from "../src/settings/credentialsStatus.js";
import { renderLimitsPage } from "../src/settings/limits/page.js";
import {
  projectNowChip,
  readProviderQuotaLimits,
  type QuotaChipState,
} from "../src/settings/limits/readModel.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  ReminderDue,
  ReminderUpdate,
  Task,
} from "../src/persistence/persistence.js";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");
const openApps: NestFastifyApplication[] = [];

function persistence(): PersistenceProvider {
  return {
    async loadState(): Promise<AssistantState> {
      return {};
    },
    async saveState(): Promise<void> {},
    async listTasks(): Promise<Task[]> {
      return [];
    },
    async addTask(title: string, category: string): Promise<Task> {
      return { id: "task-1", title, category, completed: false, createdAt: 1 };
    },
    async updateTask(): Promise<Task | null> {
      return null;
    },
    async completeTask(): Promise<Task | null> {
      return null;
    },
    async removeTask(): Promise<Task | null> {
      return null;
    },
    async listReminders(): Promise<Reminder[]> {
      return [];
    },
    async addReminder(title: string, _due?: ReminderDue): Promise<Reminder> {
      return { id: "reminder-1", title, createdAt: 1 };
    },
    async updateReminder(_id: string, _update: ReminderUpdate): Promise<Reminder | null> {
      return null;
    },
    async removeReminder(): Promise<Reminder | null> {
      return null;
    },
  };
}

function config(): HttpAppConfig {
  return {
    version: "0.1.0",
    sourceVersion: "limits-test",
    deploymentVersion: null,
    timezone: "Australia/Melbourne",
    currentToken: "limits-service-token-value",
  };
}

function credentials(host: string): CredentialsRuntime {
  return captureCredentials({
    serviceToken: "limits-service-token-value",
    httpHost: host,
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

function tabLabels(html: string): string[] {
  const nav = html.slice(html.indexOf('<nav aria-label="Settings">'), html.indexOf("</nav>"));
  return [...nav.matchAll(/>(General|Credentials|Persistence|Limits|Danger zone)</g)].map(
    (match) => match[1] ?? "",
  );
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((item) => item.close()));
});

describe("provider quota read model", () => {
  it("stays UNKNOWN when no durable store is selected", () => {
    const model = readProviderQuotaLimits();
    assert.equal(model.store, "unread");
    assert.equal(model.enforced, false);
    assert.equal(model.operatorOnly, true);
    assert.equal(model.resetPeriod, "Unknown");
    assert.match(model.banner, /not durably enforced yet/);
    assert.match(model.banner, /Partial OK/);
    assert.deepEqual(
      model.resources.map((resource) => resource.id),
      ["api-provider-rate", "concurrency", "storage-backup", "retention", "delivery"],
    );
    for (const resource of model.resources) {
      assert.equal(resource.chip, "UNKNOWN");
      assert.equal(resource.softLabel, "Soft");
      assert.equal(resource.hardLabel, "Hard");
      assert.equal(resource.hardStop, "No hard stop");
      assert.equal(resource.used, null);
      assert.equal(resource.limit, null);
      assert.equal(resource.remaining, null);
      assert.equal(resource.resetPeriod, "Unknown");
    }
    assert.equal(model.nowChip.count, 1);
    assert.equal(model.nowChip.state, "UNKNOWN");
    assert.equal(model.nowChip.href, "/settings/limits");
    assert.equal(model.nowChip.editable, false);
  });

  it("projects a single NOW chip from the worst state", () => {
    const states: QuotaChipState[] = ["OK", "NO LIMIT", "WARN", "UNKNOWN", "STOPPED"];
    const chip = projectNowChip(states);
    assert.equal(chip.count, 1);
    assert.equal(chip.state, "STOPPED");
    assert.equal(chip.href, "/settings/limits");
    assert.equal(chip.editable, false);
    assert.equal(projectNowChip([]).state, "UNKNOWN");
    assert.equal(projectNowChip(["NO LIMIT", "OK"]).state, "OK");
  });
});

describe("limits page", () => {
  it("labels soft and hard limits without inventing a green OK", () => {
    const html = renderLimitsPage(readProviderQuotaLimits());
    assert.deepEqual(tabLabels(html), [
      "General",
      "Credentials",
      "Persistence",
      "Limits",
      "Danger zone",
    ]);
    assert.match(html, /not durably enforced yet/);
    assert.match(html, /Partial OK/);
    assert.match(html, /Operator only/);
    assert.match(html, /no team-admin path/);
    assert.match(html, /Reset period Unknown/);
    assert.match(html, /data-confirm="CHANGE LIMIT"/);
    assert.match(html, /Nothing was enforced/);
    assert.match(html, /class="cancel" autofocus/);
    assert.match(html, /min-height:44px/);
    assert.match(html, /prefers-reduced-motion:\s*reduce/);
    assert.match(html, /#1c1612/);
    assert.match(html, /#c47b4a/);
    assert.doesNotMatch(html, /data-chip="OK"|data-chip="WARN"|data-chip="STOPPED"/);
    assert.equal(html.split('data-chip="UNKNOWN"').length - 1, 5);
    assert.equal(html.split("No hard stop").length - 1, 5);
    assert.equal(html.split(">Soft<").length - 1, 5);
    assert.equal(html.split(">Hard<").length - 1, 5);
    assert.doesNotMatch(html, /sessionStorage|localStorage|fetch\(|XMLHttpRequest|Bearer/);
    assert.doesNotMatch(html, /#39ff88|#b933ff|#ff2fbf|#39e6ff/i);
    assert.doesNotMatch(html, /<svg|sparkline|mascot/i);
    assert.doesNotMatch(
      html,
      /data-resource="(?:seats|billing|paywall|notifications|sessions|team-admin)"/,
    );
    assert.match(html, /href="\/settings\/limits"/);
    assert.match(html, /connect-src 'none'/);
  });
});

describe("limits shell", () => {
  it("places Limits after Persistence and projects one NOW chip", () => {
    assert.deepEqual(
      [...widget.matchAll(/data-settings-tab="([^"]+)"/g)].map((match) => match[1]),
      ["general", "credentials", "persistence", "limits", "danger"],
    );
    assert.doesNotMatch(widget, /data-settings-tab="(?:notifications|sessions)"/);
    const chips = [...widget.matchAll(/data-now-chip="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(chips, ["limits"]);
    const chip = widget.match(/<a\b[^>]*data-now-chip="limits"[^>]*>[^<]*<\/a>/);
    assert.ok(chip);
    assert.match(chip[0], /href="\/settings\/limits"/);
    assert.match(chip[0], /UNKNOWN/);
    assert.doesNotMatch(chip[0], /contenteditable|class="[^"]*\bok\b/);
    assert.doesNotMatch(chip[0], /<input/);
    const panelStart = widget.indexOf('id="view-limits"');
    const panelEnd = widget.indexOf('id="view-danger"');
    assert.ok(panelStart !== -1 && panelEnd > panelStart);
    const panel = widget.slice(panelStart, panelEnd);
    assert.match(panel, /not durably enforced yet/);
    assert.match(panel, /No hard stop/);
    assert.match(panel, /UNKNOWN/);
    assert.match(panel, /href="\/settings\/limits"/);
    assert.doesNotMatch(panel, /sessionStorage|Bearer/);
  });
});

describe("limits HTTP page", () => {
  it("serves the unread page on loopback and hides it off loopback", async () => {
    const local = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: config(),
      credentialsRuntime: credentials("127.0.0.1"),
      logger: false,
    });
    openApps.push(local);
    const page = await local.inject({ method: "GET", url: "/settings/limits" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(page.body, /not durably enforced yet/);
    assert.match(page.body, /No hard stop/);
    assert.equal(page.body.includes("limits-service-token-value"), false);
    assert.doesNotMatch(page.body, /sessionStorage/);

    const remote = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: config(),
      credentialsRuntime: credentials("10.1.1.1"),
      logger: false,
    });
    openApps.push(remote);
    const hidden = await remote.inject({ method: "GET", url: "/settings/limits" });
    assert.equal(hidden.statusCode, 404);
    assert.equal(hidden.body.includes("limits-service-token-value"), false);
  });
});

describe("neighbouring settings tabs", () => {
  it("keeps Limits between Persistence and Danger on Credentials and Danger", () => {
    const credentialsPage = renderCredentialsPage(credentials("127.0.0.1").pageModel);
    assert.deepEqual(tabLabels(credentialsPage), [
      "General",
      "Credentials",
      "Persistence",
      "Limits",
      "Danger zone",
    ]);
    const dangerPage = renderDangerZonePage(
      buildDangerZoneModel({
        provider: "json",
        facts: {
          serviceOverlap: "off",
          serviceFingerprint: null,
          approvalOverlap: "off",
          approvalFingerprint: null,
          deliveryConfigured: false,
          deliveryOverlap: "off",
          deliveryFingerprint: null,
          lastVerify: "not-run",
        },
        verifiedBackup: null,
        dataDir: "/tmp/jarvis-data",
        credentialsEndOverlapHref: "/settings/danger#end-service-overlap",
      }),
    );
    assert.deepEqual(tabLabels(dangerPage), [
      "General",
      "Credentials",
      "Persistence",
      "Limits",
      "Danger zone",
    ]);
  });
});
