import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ARCHIVE_GROUPS } from "../src/backup/archiveManifest.js";
import {
  V4_ABSENT_GROUPS,
  V4_PRESENT_GROUPS,
  buildPersistenceSettingsView,
  capturedGroupsMatchContract,
  gatePersistenceAction,
  honestV4Outcome,
  persistenceActionResultSchema,
  persistenceSettingsViewSchema,
  presentFailureDetail,
  reconcileProvider,
  type PersistenceSettingsView,
} from "../src/settings/persistenceSettings.js";
import {
  PersistenceSettingsService,
  type PersistenceSettingsPorts,
} from "../src/settings/persistenceSettingsService.js";

const NOW = new Date("2026-09-24T03:04:05.000Z");
const TOKEN = "svc-token-should-not-leak";

function viewFor(
  provider: "json" | "convex" | "misconfigured",
  health: "ok" | "fail-closed" = "ok",
): PersistenceSettingsView {
  const reconciliation =
    provider === "misconfigured"
      ? {
          kind: "misconfigured" as const,
          detail:
            "Provider misconfigured. Jarvis will not start durable commands until this is fixed.",
        }
      : { kind: "active" as const, provider };
  return buildPersistenceSettingsView({
    reconciliation,
    health: {
      state: provider === "misconfigured" ? "fail-closed" : health,
      status: health === "ok" ? "Reachable · token accepted" : "Unreachable",
      checkedAt: NOW.toISOString(),
      detail: health === "ok" ? null : "token rejected",
    },
    convexDeployment: provider === "convex" ? "dev:example" : null,
    jsonStatePath: "typescript/data/jarvis-state.json",
    now: NOW,
  });
}

function ports(calls: string[]): PersistenceSettingsPorts {
  const v4 = honestV4Outcome({
    completeness: "partial",
    coverage: { present: [...V4_PRESENT_GROUPS], absent: [...V4_ABSENT_GROUPS] },
    unresolvedReferences: [{}, {}],
    verification: { groups: V4_PRESENT_GROUPS.map((group) => ({ group })) },
  });
  const counts = {
    tasks: 1,
    reminders: 2,
    builds: 0,
    buildLogs: 0,
    upgrades: 0,
    assets: 0,
    preferences: 0,
  };
  return {
    async probe() {
      return { state: "ok", status: "State file readable", detail: null };
    },
    async exportClassic() {
      calls.push("export-classic");
      return counts;
    },
    async verifyClassic() {
      calls.push("verify-classic");
      return counts;
    },
    async restoreClassic() {
      calls.push("restore-classic");
      return counts;
    },
    async exportV4() {
      calls.push("export-v4");
      return v4;
    },
    async verifyV4() {
      calls.push("verify-v4");
      return v4;
    },
    async restoreV4(_file, _destination, flags) {
      calls.push(`restore-v4:${flags.resume ? "resume" : "plain"}`);
      return v4;
    },
    async inspectV4Destination() {
      calls.push("inspect");
      return { kind: "fresh", resumeAvailable: false, detail: "fresh" };
    },
  };
}

function service(running: "json" | "convex", envProvider: string | undefined, calls: string[]) {
  const env: NodeJS.ProcessEnv = {};
  if (envProvider !== undefined) env.PERSISTENCE_PROVIDER = envProvider;
  if (running === "convex") env.CONVEX_DEPLOYMENT = "dev:example";
  return new PersistenceSettingsService({
    runningProvider: running,
    env,
    jsonStatePath: "typescript/data/jarvis-state.json",
    now: () => NOW,
    secrets: [TOKEN],
    ports: ports(calls),
  });
}

describe("Persistence settings", () => {
  it("keeps v4 absent groups aligned with the archive contract", () => {
    assert.equal(capturedGroupsMatchContract(), true);
    assert.deepEqual(
      ARCHIVE_GROUPS.filter((group) => !(V4_PRESENT_GROUPS as readonly string[]).includes(group)),
      [...V4_ABSENT_GROUPS],
    );
  });

  it("shows the env provider and never offers a silent switch or JSON fallback", async () => {
    const calls: string[] = [];
    const convex = await service("convex", "convex", calls).read();
    assert.equal(convex.provider.active, "convex");
    assert.equal(convex.provider.convexDeployment, "dev:example");
    assert.equal(convex.provider.radiosDisabled, true);
    assert.equal(convex.fallbackCta, null);
    assert.equal(convex.providerSwitch, null);
    assert.equal(convex.backup.v4ExportEnabled, false);
    assert.match(convex.honesty, /will not silently fall back/i);
    assert.match(
      convex.backup.exportWarning,
      /must not contain service, approval, or delivery tokens/i,
    );
    assert.doesNotMatch(JSON.stringify(convex), /try json|fall back to json/i);
    assert.equal(persistenceSettingsViewSchema.safeParse(convex).success, true);

    const json = await service("json", undefined, calls).read();
    assert.equal(json.provider.active, "json");
    assert.equal(json.provider.convexDeployment, null);
    assert.equal(json.backup.v4Label, "Partial / JSON-only");
    assert.equal(json.backup.restoreDrillExposed, false);
    assert.equal(
      json.backup.commands.some(
        (entry) => entry.command === "npm run restore-drill" && !entry.exposedInSettings,
      ),
      true,
    );
  });

  it("fail-closes a misconfigured provider instead of using the running one", async () => {
    const calls: string[] = [];
    const view = await service("json", "postgres", calls).read();
    assert.equal(view.provider.active, null);
    assert.equal(view.provider.misconfigured, true);
    assert.match(view.provider.banner ?? "", /will not start durable commands/i);
    assert.equal(view.health.state, "fail-closed");
    assert.equal(view.actions.exportClassic, false);
    assert.equal(view.actions.verifyClassic, true);
    assert.doesNotMatch(JSON.stringify(view), /try json instead/i);
  });

  it("refuses v4 export on Convex before calling the exporter", async () => {
    const calls: string[] = [];
    const result = await service("convex", "convex", calls).run({
      action: "export-v4",
      file: "backups/jarvis-v4.json",
    });
    assert.equal(result.status, "refused");
    assert.equal(result.code, "v4-export-refused");
    assert.match(result.detail, /JSON-only|selects "convex"/);
    assert.doesNotMatch(result.detail, /try json instead/i);
    assert.deepEqual(calls, []);
  });

  it("requires the empty-target confirmation before classic restore", async () => {
    const calls: string[] = [];
    const settings = service("json", "json", calls);
    const refused = await settings.run({
      action: "restore-classic",
      file: "backups/jarvis.json",
      confirmEmptyTarget: false,
    });
    assert.equal(refused.code, "empty-target-required");
    assert.match(refused.detail, /--confirm-empty-target/);
    assert.match(refused.detail, /will not merge/i);
    assert.deepEqual(calls, []);

    const allowed = await settings.run({
      action: "restore-classic",
      file: "backups/jarvis.json",
      confirmEmptyTarget: true,
      understandIdsRecreated: true,
      typedConfirmation: "restore",
    });
    assert.equal(allowed.status, "completed");
    assert.deepEqual(calls, ["restore-classic"]);
  });

  it("requires allow-partial and does not resume unless the action is resume-v4", async () => {
    const calls: string[] = [];
    const settings = service("json", "json", calls);
    const missingFlag = await settings.run({
      action: "restore-v4",
      file: "archive.json",
      destination: "/tmp/restore",
      allowPartial: false,
      acknowledgePartial: true,
      typedConfirmation: "restore-v4",
    });
    assert.equal(missingFlag.code, "allow-partial-required");
    assert.deepEqual(calls, []);

    const silentResume = await settings.run({
      action: "restore-v4",
      file: "archive.json",
      destination: "/tmp/restore",
      allowPartial: true,
      acknowledgePartial: true,
      resume: true,
      typedConfirmation: "restore-v4",
    });
    assert.equal(silentResume.code, "resume-not-default");
    assert.match(silentResume.detail, /never the default/);
    assert.deepEqual(calls, []);

    const plain = await settings.run({
      action: "restore-v4",
      file: "archive.json",
      destination: "/tmp/restore",
      allowPartial: true,
      acknowledgePartial: true,
      typedConfirmation: "restore-v4",
    });
    assert.equal(plain.status, "completed");
    assert.match(plain.detail, /Resume was not used/);
    assert.equal(plain.v4?.completeness, "partial");
    for (const group of V4_ABSENT_GROUPS) assert.match(plain.v4?.headline ?? "", new RegExp(group));
    assert.match(plain.detail, /not a complete backup/i);
    assert.doesNotMatch(plain.detail, /full backup/i);

    const resume = await settings.run({
      action: "resume-v4",
      file: "archive.json",
      destination: "/tmp/restore",
      allowPartial: true,
      acknowledgePartial: true,
      resume: true,
      typedConfirmation: "restore-v4",
    });
    assert.equal(resume.status, "completed");
    assert.deepEqual(calls, ["restore-v4:plain", "restore-v4:resume"]);
    assert.equal(persistenceActionResultSchema.safeParse(resume).success, true);
  });

  it("redacts service tokens and names a non-empty classic target without offering a merge", async () => {
    const calls: string[] = [];
    const env: NodeJS.ProcessEnv = { PERSISTENCE_PROVIDER: "json" };
    const base = ports(calls);
    const settings = new PersistenceSettingsService({
      runningProvider: "json",
      env,
      now: () => NOW,
      secrets: [TOKEN],
      ports: {
        ...base,
        async restoreClassic() {
          calls.push("restore-classic");
          throw new Error(`Restore refused: the target tasks store is not empty. token ${TOKEN}`);
        },
      },
    });
    const result = await settings.run({
      action: "restore-classic",
      file: "backups/jarvis.json",
      confirmEmptyTarget: true,
      understandIdsRecreated: true,
      typedConfirmation: "restore",
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "target-not-empty");
    assert.equal(result.detail.includes(TOKEN), false);
    assert.match(result.detail, /\[REDACTED\]/);
    assert.match(result.detail, /Export first or use an empty target/);
    assert.match(result.detail, /will not merge/i);
  });

  it("keeps a partial archive from being described as a complete backup", () => {
    const outcome = honestV4Outcome({
      completeness: "complete",
      coverage: { present: [...V4_PRESENT_GROUPS], absent: [...V4_ABSENT_GROUPS] },
      unresolvedReferences: [],
      verification: null,
    });
    assert.equal(outcome.completeness, "partial");
    assert.match(outcome.headline, /not a complete backup/);
    assert.doesNotMatch(
      presentFailureDetail(`bearer ${TOKEN} try json instead`, [TOKEN]),
      /try json instead/i,
    );
    assert.match(presentFailureDetail(`bearer ${TOKEN}`, [TOKEN]), /\[REDACTED\]/);
  });

  it("still allows verify when the provider is fail-closed", () => {
    const view = viewFor("convex", "fail-closed");
    assert.equal(view.actions.verifyClassic, true);
    assert.equal(view.actions.verifyV4, true);
    assert.equal(view.actions.exportClassic, false);
    const gate = gatePersistenceAction(view, {
      action: "verify-classic",
      file: "backups/jarvis.json",
    });
    assert.equal(gate.ok, true);
    assert.equal(reconcileProvider("convex", "json").kind, "misconfigured");
  });
});
