import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  CLEAR_LOCAL_BASENAMES,
  DANGER_ZONE_CONFIRM,
  DangerZoneRefusal,
  DangerZoneService,
  RESET_JSON_BASENAMES,
  writeBackupVerifyReceipt,
} from "../src/settings/dangerZone/index.js";
import { dangerZoneCardHref } from "../src/settings/credentials/endOverlap.js";
import { renderDangerZonePage } from "../src/settings/dangerZone/page.js";
import { removeConvexPreviousEnv } from "../src/settings/dangerZone/convexEnv.js";
import { quarantineNamedFiles } from "../src/settings/dangerZone/quarantine.js";

const SECRET = "super-secret-token-value-aaaa";
const PREVIOUS = "previous-secret-token-value-bbbb";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-danger-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function service(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  backups?: string;
  provider?: "json" | "convex";
  runs?: string[];
  logs?: string[];
  lockTimeoutMs?: number;
  now?: () => Date;
  localEnv?: string;
}): DangerZoneService {
  const runs = options.runs ?? [];
  return new DangerZoneService({
    dataDir: options.dataDir,
    provider: options.provider ?? "json",
    env: options.env ?? {},
    localEnvPath: options.localEnv ?? path.join(options.dataDir, ".env.local"),
    backupDirectories: options.backups === undefined ? [] : [options.backups],
    convexCwd: options.dataDir,
    lockTimeoutMs: options.lockTimeoutMs ?? 200,
    now: options.now,
    hostname: "operator-host",
    pid: 4242,
    runConvexCommand: (command, args) => {
      runs.push([command, ...args].join(" "));
      return Promise.resolve({ code: 0 });
    },
    log: (line) => options.logs?.push(line),
  });
}

describe("danger zone confirmations", () => {
  it("requires the exact shared confirm strings", () => {
    assert.equal(DANGER_ZONE_CONFIRM["end-service-overlap"], "END OVERLAP");
    assert.equal(DANGER_ZONE_CONFIRM["end-approval-overlap"], "END APPROVAL OVERLAP");
    assert.equal(DANGER_ZONE_CONFIRM["end-delivery-overlap"], "END DELIVERY OVERLAP");
    assert.equal(DANGER_ZONE_CONFIRM["reset-local-json"], "RESET JSON");
    assert.equal(DANGER_ZONE_CONFIRM["clear-local"], "CLEAR LOCAL");
    assert.equal(dangerZoneCardHref("end-service-overlap"), "/settings/danger#end-service-overlap");
  });

  it("blocks a wrong, cased, or padded confirmation", async () => {
    const dataDir = await tempDir();
    const env = { JARVIS_SERVICE_TOKEN: SECRET, JARVIS_SERVICE_TOKEN_PREVIOUS: PREVIOUS };
    const zone = service({ dataDir, env });
    for (const typed of ["end overlap", "END OVERLAP ", "end OVERLAP"]) {
      await assert.rejects(
        () => zone.execute("end-service-overlap", { confirmation: typed }),
        (error: unknown) => {
          assert.ok(error instanceof DangerZoneRefusal);
          assert.equal(error.code, "confirm");
          assert.equal(error.message.includes(PREVIOUS), false);
          return true;
        },
      );
    }
    assert.equal(env.JARVIS_SERVICE_TOKEN_PREVIOUS, PREVIOUS);
  });
});

describe("end overlap", () => {
  it("is disabled when overlap is off and does not call Convex", async () => {
    const dataDir = await tempDir();
    const runs: string[] = [];
    const zone = service({
      dataDir,
      env: { JARVIS_SERVICE_TOKEN: SECRET },
      runs,
    });
    const model = await zone.inspect();
    const card = model.cards.find((entry) => entry.id === "end-service-overlap");
    assert.equal(card?.enabled, false);
    assert.equal(card?.disabledReason, "No previous token accepted.");
    await assert.rejects(
      () => zone.execute("end-service-overlap", { confirmation: "END OVERLAP" }),
      (error: unknown) => error instanceof DangerZoneRefusal && error.code === "disabled",
    );
    assert.deepEqual(runs, []);
  });

  it("disables delivery overlap when the delivery token is absent", async () => {
    const dataDir = await tempDir();
    const runs: string[] = [];
    const zone = service({
      dataDir,
      runs,
      env: { JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS: PREVIOUS },
    });
    const model = await zone.inspect();
    const card = model.cards.find((entry) => entry.id === "end-delivery-overlap");
    assert.equal(card?.enabled, false);
    assert.equal(card?.overlap, "not-configured");
    assert.equal(card?.disabledReason, "Delivery token is not configured.");
    assert.equal(JSON.stringify(model).includes(PREVIOUS), false);
    await assert.rejects(
      () => zone.execute("end-delivery-overlap", { confirmation: "END DELIVERY OVERLAP" }),
      (error: unknown) => error instanceof DangerZoneRefusal && error.code === "disabled",
    );
    assert.deepEqual(runs, []);
  });

  it("removes only the named previous variable and writes a redacted audit line", async () => {
    const dataDir = await tempDir();
    const backups = await tempDir();
    const envFile = path.join(dataDir, ".env.local");
    const env = {
      JARVIS_SERVICE_TOKEN: SECRET,
      JARVIS_SERVICE_TOKEN_PREVIOUS: PREVIOUS,
      JARVIS_APPROVAL_TOKEN_PREVIOUS: "approval-previous-token-value",
    };
    await fs.writeFile(
      envFile,
      `JARVIS_SERVICE_TOKEN=${SECRET}\nJARVIS_SERVICE_TOKEN_PREVIOUS=${PREVIOUS}\nJARVIS_TIMEZONE=Australia/Melbourne\n`,
      "utf8",
    );
    const runs: string[] = [];
    const logs: string[] = [];
    const zone = service({ dataDir, env, backups, runs, logs, localEnv: envFile });
    const before = await zone.inspect();
    const card = before.cards.find((entry) => entry.id === "end-service-overlap");
    assert.equal(card?.enabled, true);
    assert.equal(card?.overlap, "on");
    assert.match(card?.warning ?? "", /old token will break immediately/);
    assert.match(card?.blastRadius[0] ?? "", /Immediately revokes JARVIS_SERVICE_TOKEN_PREVIOUS/);
    assert.match(card?.blastRadius[0] ?? "", /no grace period/);
    const fingerprint = createHash("sha256").update(SECRET).digest("hex");
    assert.equal(card?.fingerprint, `${fingerprint.slice(0, 4)}…${fingerprint.slice(-4)}`);

    const result = await zone.execute("end-service-overlap", { confirmation: "END OVERLAP" });
    assert.deepEqual(runs, ["npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS"]);
    assert.equal(result.convexDataDeletes, 0);
    assert.equal(result.overlap, "off");
    assert.equal(env.JARVIS_SERVICE_TOKEN_PREVIOUS, undefined);
    assert.equal(env.JARVIS_APPROVAL_TOKEN_PREVIOUS, "approval-previous-token-value");
    const updated = await fs.readFile(envFile, "utf8");
    assert.equal(updated.includes(PREVIOUS), false);
    assert.match(updated, /JARVIS_SERVICE_TOKEN=/);
    assert.match(updated, /JARVIS_TIMEZONE=Australia\/Melbourne/);
    const audit = await fs.readFile(path.join(dataDir, "jarvis-operator-audit.jsonl"), "utf8");
    assert.match(audit, /"actionId":"end-service-overlap"/);
    assert.equal(audit.includes(SECRET), false);
    assert.equal(audit.includes(PREVIOUS), false);
    assert.equal(logs.join("\n").includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes(PREVIOUS), false);
    assert.match(result.detail, /Immediately removed JARVIS_SERVICE_TOKEN_PREVIOUS/);
    assert.match(result.detail, /no grace period/);
    const after = await zone.inspect();
    assert.equal(after.cards.find((entry) => entry.id === "end-service-overlap")?.enabled, false);
  });

  it("leaves overlap in place when Convex env remove fails", async () => {
    const dataDir = await tempDir();
    const envFile = path.join(dataDir, ".env.local");
    await fs.writeFile(envFile, `JARVIS_SERVICE_TOKEN_PREVIOUS=${PREVIOUS}\n`, "utf8");
    const env = { JARVIS_SERVICE_TOKEN: SECRET, JARVIS_SERVICE_TOKEN_PREVIOUS: PREVIOUS };
    const zone = new DangerZoneService({
      dataDir,
      provider: "json",
      env,
      localEnvPath: envFile,
      backupDirectories: [],
      convexCwd: dataDir,
      runConvexCommand: () => Promise.resolve({ code: 1 }),
    });
    await assert.rejects(
      () => zone.execute("end-service-overlap", { confirmation: "END OVERLAP" }),
      (error: unknown) => {
        assert.ok(error instanceof DangerZoneRefusal);
        assert.equal(error.code, "overlap-unchanged");
        assert.match(error.message, /left in place/);
        assert.equal(error.message.includes(PREVIOUS), false);
        return true;
      },
    );
    assert.equal(env.JARVIS_SERVICE_TOKEN_PREVIOUS, PREVIOUS);
    assert.match(await fs.readFile(envFile, "utf8"), new RegExp(PREVIOUS));
  });

  it("refuses to remove an unlisted Convex variable", async () => {
    await assert.rejects(
      () =>
        removeConvexPreviousEnv("JARVIS_SERVICE_TOKEN", {
          cwd: process.cwd(),
          run: () => Promise.resolve({ code: 0 }),
        }),
      (error: unknown) => error instanceof DangerZoneRefusal && error.code === "overlap-unchanged",
    );
  });
});

describe("reset local JSON", () => {
  it("quarantines only the core state file and does not call Convex", async () => {
    const dataDir = await tempDir();
    await fs.writeFile(path.join(dataDir, "jarvis-state.json"), `{"token":"${SECRET}"}`, "utf8");
    await fs.writeFile(path.join(dataDir, "jarvis-clients.json"), '{"clients":[1]}', "utf8");
    await fs.writeFile(path.join(dataDir, "unrelated.json"), "leave-me", "utf8");
    const runs: string[] = [];
    const zone = service({ dataDir, runs, provider: "convex" });
    const model = await zone.inspect();
    const card = model.cards.find((entry) => entry.id === "reset-local-json");
    assert.match(card?.blastRadius.join(" ") ?? "", /Convex data is NOT modified/);
    assert.match(card?.blastRadius.join(" ") ?? "", /live provider is Convex/);
    assert.deepEqual(
      card?.willQuarantine.map((filePath) => path.basename(filePath)),
      [...RESET_JSON_BASENAMES],
    );

    await assert.rejects(
      () => zone.execute("reset-local-json", { confirmation: "RESET JSON" }),
      (error: unknown) => error instanceof DangerZoneRefusal && error.code === "confirm",
    );

    const result = await zone.execute("reset-local-json", {
      confirmation: "RESET JSON",
      acceptEmptyLocalCore: true,
    });
    assert.equal(result.convexDataDeletes, 0);
    assert.deepEqual(runs, []);
    assert.equal(
      await fs.readFile(path.join(dataDir, "jarvis-clients.json"), "utf8"),
      '{"clients":[1]}',
    );
    assert.equal(await fs.readFile(path.join(dataDir, "unrelated.json"), "utf8"), "leave-me");
    const names = await fs.readdir(dataDir);
    assert.equal(names.includes("jarvis-state.json"), false);
    const quarantined = names.find((name) => name.startsWith("jarvis-state.json.corrupt-"));
    assert.ok(quarantined);
    assert.equal(
      await fs.readFile(path.join(dataDir, quarantined), "utf8"),
      `{"token":"${SECRET}"}`,
    );
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    const source = await fs.readFile(
      new URL("../src/settings/dangerZone/quarantine.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /from ["'].*convex|mutation\(|deleteOwner/);
  });

  it("refuses a live lock and a symlink that leaves the data directory", async () => {
    const dataDir = await tempDir();
    const outside = path.join(await tempDir(), "outside.json");
    await fs.writeFile(outside, "outside-bytes");
    await fs.writeFile(
      path.join(dataDir, "jarvis-state.json.lock"),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: "held-lock" }),
      "utf8",
    );
    await fs.writeFile(path.join(dataDir, "jarvis-state.json"), "{}", "utf8");
    const zone = service({ dataDir, lockTimeoutMs: 40 });
    await assert.rejects(
      () =>
        zone.execute("reset-local-json", {
          confirmation: "RESET JSON",
          acceptEmptyLocalCore: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof DangerZoneRefusal);
        assert.equal(error.code, "lock");
        assert.match(error.message, /locked by process/);
        return true;
      },
    );
    assert.equal(await fs.readFile(path.join(dataDir, "jarvis-state.json"), "utf8"), "{}");

    const linkedDir = await tempDir();
    await fs.symlink(outside, path.join(linkedDir, "jarvis-state.json"));
    await assert.rejects(
      () =>
        quarantineNamedFiles({
          dataDir: linkedDir,
          basenames: ["jarvis-state.json"],
          lockTimeoutMs: 200,
          now: () => new Date("2026-09-24T00:00:00.000Z"),
        }),
      (error: unknown) => {
        assert.ok(error instanceof DangerZoneRefusal);
        assert.equal(error.code, "path");
        assert.match(error.message, /outside the Jarvis data directory/);
        return true;
      },
    );
    assert.equal(await fs.readFile(outside, "utf8"), "outside-bytes");
  });

  it("reclaims a lock left by a process that is not alive", async () => {
    const dataDir = await tempDir();
    await fs.writeFile(path.join(dataDir, "jarvis-state.json"), '{"ok":true}', "utf8");
    await fs.writeFile(
      path.join(dataDir, "jarvis-state.json.lock"),
      JSON.stringify({ pid: 2_147_483_646, acquiredAt: Date.now(), token: "stale-lock" }),
      "utf8",
    );
    const quarantined = await quarantineNamedFiles({
      dataDir,
      basenames: ["jarvis-state.json"],
      lockTimeoutMs: 500,
      now: () => new Date("2026-09-24T00:00:00.000Z"),
    });
    assert.equal(quarantined.length, 1);
    assert.equal((await fs.readdir(dataDir)).includes("jarvis-state.json"), false);
  });

  it("names a permission failure", async () => {
    const dataDir = await tempDir();
    await fs.writeFile(path.join(dataDir, "jarvis-state.json"), "{}", "utf8");
    await fs.chmod(dataDir, 0o555);
    try {
      if (typeof process.getuid === "function" && process.getuid() === 0) return;
      await assert.rejects(
        () =>
          quarantineNamedFiles({
            dataDir,
            basenames: ["jarvis-state.json"],
            lockTimeoutMs: 200,
            now: () => new Date(),
          }),
        (error: unknown) => {
          assert.ok(error instanceof DangerZoneRefusal);
          assert.equal(error.code, "permission");
          assert.match(error.message, /permission denied \(EACCES\)/);
          return true;
        },
      );
    } finally {
      await fs.chmod(dataDir, 0o755);
    }
  });
});

describe("clear local", () => {
  it("requires a verified backup or an explicit skip, and never touches Convex", async () => {
    const dataDir = await tempDir();
    const backups = await tempDir();
    await fs.writeFile(path.join(dataDir, "jarvis-state.json"), "{}", "utf8");
    await fs.writeFile(path.join(dataDir, "jarvis-builds.json"), "[]", "utf8");
    await fs.writeFile(path.join(dataDir, "jarvis-clients.json"), "[]", "utf8");
    await fs.writeFile(path.join(dataDir, "unrelated.json"), "keep", "utf8");
    const runs: string[] = [];
    const zone = service({ dataDir, backups, runs, provider: "convex" });
    const model = await zone.inspect();
    const card = model.cards.find((entry) => entry.id === "clear-local");
    assert.equal(card?.enabled, true);
    assert.match(card?.blastRadius.join(" ") ?? "", /Convex is untouched/);
    assert.equal(
      model.cards.some((entry) => entry.id.includes("convex") || /nuke/i.test(entry.title)),
      false,
    );
    assert.ok(model.excluded.some((entry) => entry.id === "wipe-convex-owner"));

    await assert.rejects(
      () => zone.execute("clear-local", { confirmation: "CLEAR LOCAL" }),
      (error: unknown) => error instanceof DangerZoneRefusal && error.code === "backup",
    );
    await assert.rejects(
      () =>
        zone.execute("clear-local", {
          confirmation: "CLEAR LOCAL",
          backup: { mode: "skip", acceptIrreversibleLoss: false },
        }),
      (error: unknown) => error instanceof DangerZoneRefusal && error.code === "backup",
    );

    const archive = path.join(backups, "jarvis-backup.json");
    await fs.writeFile(archive, "{}\n", "utf8");
    const now = new Date("2026-09-24T03:00:00.000Z");
    await writeBackupVerifyReceipt(archive, new Date(now.getTime() - 60 * 60 * 1000));
    const verified = await zone.execute("clear-local", {
      confirmation: "CLEAR LOCAL",
      backup: { mode: "verified", path: archive },
    });
    assert.equal(verified.convexDataDeletes, 0);
    assert.deepEqual(runs, []);
    assert.equal(await fs.readFile(path.join(dataDir, "unrelated.json"), "utf8"), "keep");
    assert.equal(await fs.readFile(archive, "utf8"), "{}\n");
    const names = await fs.readdir(dataDir);
    for (const basename of ["jarvis-state.json", "jarvis-builds.json", "jarvis-clients.json"]) {
      assert.equal(names.includes(basename), false);
      assert.ok(names.some((name) => name.startsWith(`${basename}.corrupt-`)));
    }
    assert.ok(CLEAR_LOCAL_BASENAMES.includes("jarvis-business-settings.json"));
    assert.equal(CLEAR_LOCAL_BASENAMES.includes("unrelated.json"), false);
  });

  it("quarantines local files when the operator explicitly skips backup", async () => {
    const dataDir = await tempDir();
    await fs.writeFile(path.join(dataDir, "jarvis-preferences.json"), "prefs", "utf8");
    const runs: string[] = [];
    const zone = service({ dataDir, runs });
    const result = await zone.execute("clear-local", {
      confirmation: "CLEAR LOCAL",
      backup: { mode: "skip", acceptIrreversibleLoss: true },
    });
    assert.equal(result.convexDataDeletes, 0);
    assert.deepEqual(runs, []);
    const names = await fs.readdir(dataDir);
    assert.equal(names.includes("jarvis-preferences.json"), false);
    assert.ok(names.some((name) => name.startsWith("jarvis-preferences.json.corrupt-")));
  });

  it("rejects a stale receipt and a backup path inside the live data directory", async () => {
    const dataDir = await tempDir();
    const backups = await tempDir();
    const zone = service({
      dataDir,
      backups,
      now: () => new Date("2026-09-24T03:00:00.000Z"),
    });
    const archive = path.join(backups, "old.json");
    await fs.writeFile(archive, "{}\n", "utf8");
    await writeBackupVerifyReceipt(archive, new Date("2026-09-22T03:00:00.000Z"));
    await assert.rejects(
      () =>
        zone.execute("clear-local", {
          confirmation: "CLEAR LOCAL",
          backup: { mode: "verified", path: archive },
        }),
      (error: unknown) => error instanceof DangerZoneRefusal && error.code === "backup",
    );

    const liveArchive = path.join(dataDir, "live.json");
    await fs.writeFile(liveArchive, "{}\n", "utf8");
    await writeBackupVerifyReceipt(liveArchive, new Date("2026-09-24T02:00:00.000Z"));
    const liveZone = service({
      dataDir,
      backups: dataDir,
      now: () => new Date("2026-09-24T03:00:00.000Z"),
    });
    await assert.rejects(
      () =>
        liveZone.execute("clear-local", {
          confirmation: "CLEAR LOCAL",
          backup: { mode: "verified", path: liveArchive },
        }),
      (error: unknown) => error instanceof DangerZoneRefusal && error.code === "path",
    );
  });
});

describe("danger zone page", () => {
  it("renders blast radius, shared confirms, disabled overlap, and CLI help", async () => {
    const dataDir = await tempDir();
    const zone = service({
      dataDir,
      provider: "convex",
      env: {
        JARVIS_SERVICE_TOKEN: SECRET,
        JARVIS_APPROVAL_TOKEN: SECRET,
        JARVIS_APPROVAL_TOKEN_PREVIOUS: PREVIOUS,
      },
    });
    const html = renderDangerZonePage(await zone.inspect());
    assert.match(html, /<h1>Danger zone<\/h1>/);
    assert.match(html, /These actions can interrupt Jarvis or destroy local state/);
    assert.match(html, /JARVIS_SERVICE_TOKEN_PREVIOUS/);
    assert.match(html, /No previous token accepted\./);
    assert.match(html, /Delivery token is not configured\./);
    assert.match(html, /class="blast">Immediately revokes JARVIS_SERVICE_TOKEN_PREVIOUS/);
    assert.match(html, /There is no grace period/);
    assert.match(html, /Type END OVERLAP to confirm\. The match is exact\./);
    assert.match(html, /data-confirm="END OVERLAP"/);
    assert.match(html, /The token value is not shown/);
    assert.match(html, /sent once with the action and then cleared/);
    assert.doesNotMatch(html, /tokenField\.value = token|localStorage|type="text"/);
    assert.match(html, /data-confirm="END APPROVAL OVERLAP"/);
    assert.match(html, /data-confirm="END DELIVERY OVERLAP"/);
    assert.match(html, /data-confirm="RESET JSON"/);
    assert.match(html, /data-confirm="CLEAR LOCAL"/);
    assert.match(html, /autocomplete="off"/);
    assert.match(html, /class="cancel" autofocus/);
    assert.match(html, /npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS/);
    assert.match(html, /npx convex env remove JARVIS_APPROVAL_TOKEN_PREVIOUS/);
    assert.match(html, /npx convex env remove JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS/);
    assert.match(html, /npm run backup -- export/);
    assert.match(html, /Open Persistence Backup/);
    assert.match(html, /href="\/settings\/persistence#backup"/);
    assert.match(html, /Convex owner data is untouched/);
    assert.equal(html.split("I skip backup and accept irreversible local loss").length - 1, 1);
    assert.doesNotMatch(html, /sessionStorage|name="backupMode"|#39ff88|#b933ff|#ff2fbf|#39e6ff/i);
    assert.match(html, /prefers-reduced-motion:\s*reduce/);
    assert.match(html, /min-height:44px/);
    assert.match(html, /#1c1612/);
    assert.match(html, /#c47b4a/);
    assert.equal(/nuke everything/i.test(html), false);
    assert.equal(html.includes(SECRET), false);
    assert.equal(html.includes(PREVIOUS), false);
    const serviceCard = html.slice(
      html.indexOf('id="end-service-overlap"'),
      html.indexOf('id="end-approval-overlap"'),
    );
    assert.match(serviceCard, /disabled/);
    const approvalCard = html.slice(
      html.indexOf('id="end-approval-overlap"'),
      html.indexOf('id="end-delivery-overlap"'),
    );
    assert.equal(approvalCard.includes(">End overlap…</button>"), true);
    assert.equal(/<button[^>]*disabled[^>]*>End overlap…/.test(approvalCard), false);
  });
});
