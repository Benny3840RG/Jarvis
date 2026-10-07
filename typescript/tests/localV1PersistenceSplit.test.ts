import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonAssetStore } from "../src/assets/jsonAssetStore.js";
import {
  ARCHIVE_GROUPS,
  ArchiveManifestError,
  VERIFICATION_METHOD,
  assertRecoverable,
  buildManifest,
  groupChecksum,
  type ArchiveGroup,
  type ArchiveGroupEntry,
  type ArchiveVerification,
} from "../src/backup/archiveManifest.js";
import { exportBackup } from "../src/backup/backup.js";
import { StrictBackupError } from "../src/backup/strictValues.js";
import { exportArchiveV4File } from "../src/tools/runBackupV4.js";
import { resolveJsonSourceConfig } from "../src/backup/v4/jsonSource.js";
import { JsonBuildLogStore } from "../src/buildLog/jsonBuildLogStore.js";
import { JsonBuildStore } from "../src/builds/jsonBuildStore.js";
import { ConvexBuildStore } from "../src/builds/convexBuildStore.js";
import { JsonBusinessSettingsStore } from "../src/businessSettings/jsonBusinessSettingsStore.js";
import { JsonClientStore } from "../src/clients/jsonClientStore.js";
import { JsonEnquiryStore } from "../src/enquiries/jsonEnquiryStore.js";
import { JsonErrandStore } from "../src/errands/jsonErrandStore.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import {
  HTTP_ASSET_STORE,
  HTTP_BUILD_LOG_STORE,
  HTTP_BUILD_STORE,
  HTTP_BUSINESS_SETTINGS_STORE,
  HTTP_CLIENT_STORE,
  HTTP_ENQUIRY_STORE,
  HTTP_ERRAND_STORE,
  HTTP_INVOICE_STORE,
  HTTP_PERSISTENCE,
  HTTP_PREFERENCE_STORE,
  HTTP_PROJECT_STORE,
  HTTP_PROPERTY_STORE,
  HTTP_PROVIDER_NAME,
  HTTP_QUOTE_REPOSITORY,
  HTTP_QUOTE_STORE,
  HTTP_UPGRADE_STORE,
} from "../src/http/tokens.js";
import { JsonInvoiceStore } from "../src/invoices/jsonInvoiceStore.js";
import { ConvexPersistence } from "../src/persistence/convexPersistence.js";
import { JSONPersistence } from "../src/persistence/jsonPersistence.js";
import { JsonPreferenceStore } from "../src/preferences/jsonPreferenceStore.js";
import { ConvexPreferenceStore } from "../src/preferences/convexPreferenceStore.js";
import { JsonProjectStore } from "../src/projects/jsonProjectStore.js";
import { JsonPropertyStore } from "../src/properties/jsonPropertyStore.js";
import { ConvexQuoteRepository } from "../src/quotes/convexQuoteRepository.js";
import { JsonQuoteStore } from "../src/quotes/jsonQuoteStore.js";
import { ConvexBuildLogStore } from "../src/buildLog/convexBuildLogStore.js";
import { ConvexAssetStore } from "../src/assets/convexAssetStore.js";
import { ConvexUpgradeStore } from "../src/upgrades/convexUpgradeStore.js";
import { JsonUpgradeStore } from "../src/upgrades/jsonUpgradeStore.js";

const AT = new Date("2026-10-07T00:00:00.000Z");

/**
 * Not a credential. Long enough for the HTTP config secret check, and paired
 * with a non-routable Convex URL so constructing the app cannot reach a deployment.
 */
const LOCK_TOKEN = "lv1-09-lock-token-not-a-credential-0001";
const LOCK_CONVEX_URL = "https://lv1-09-lock.invalid";

const ENV_KEYS = [
  "PERSISTENCE_PROVIDER",
  "JARVIS_SERVICE_TOKEN",
  "JARVIS_DELIVERY_RUNTIME_TOKEN",
  "JARVIS_SERVICE_TOKEN_PREVIOUS",
  "JARVIS_APPROVAL_TOKEN",
  "JARVIS_APPROVAL_TOKEN_PREVIOUS",
  "CONVEX_URL",
  "JARVIS_HTTP_HOST",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

function entry(group: ArchiveGroup): ArchiveGroupEntry {
  return {
    group,
    schemaVersion: 1,
    counts: {},
    checksum: groupChecksum({ group, counts: {} }),
    consistentSnapshot: true,
  };
}

function verificationFor(groups: readonly ArchiveGroup[]): ArchiveVerification {
  return {
    verifiedAt: AT.toISOString(),
    method: VERIFICATION_METHOD,
    groups: groups.map((group) => ({
      group,
      restoredChecksum: groupChecksum({ group, counts: {} }),
    })),
  };
}

async function withConvexProviderEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);
  process.env.PERSISTENCE_PROVIDER = "convex";
  process.env.JARVIS_SERVICE_TOKEN = LOCK_TOKEN;
  process.env.JARVIS_DELIVERY_RUNTIME_TOKEN = LOCK_TOKEN;
  process.env.CONVEX_URL = LOCK_CONVEX_URL;
  process.env.JARVIS_HTTP_HOST = "127.0.0.1";
  delete process.env.JARVIS_SERVICE_TOKEN_PREVIOUS;
  delete process.env.JARVIS_APPROVAL_TOKEN;
  delete process.env.JARVIS_APPROVAL_TOKEN_PREVIOUS;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("LV1-09 live persistence split", () => {
  it("keeps business JSON on disk and tasks, workshop memory, and quote lifecycle on Convex", async () => {
    await withConvexProviderEnv(async () => {
      assert.equal(process.env.CONVEX_URL, LOCK_CONVEX_URL);
      const app = await createJarvisHttpApp({ logger: false });
      try {
        assert.equal(app.get(HTTP_PROVIDER_NAME), "convex");
        assert.ok(app.get(HTTP_PERSISTENCE) instanceof ConvexPersistence);
        assert.ok(app.get(HTTP_CLIENT_STORE) instanceof JsonClientStore);
        assert.ok(app.get(HTTP_PROPERTY_STORE) instanceof JsonPropertyStore);
        assert.ok(app.get(HTTP_PROJECT_STORE) instanceof JsonProjectStore);
        assert.ok(app.get(HTTP_ENQUIRY_STORE) instanceof JsonEnquiryStore);
        assert.ok(app.get(HTTP_INVOICE_STORE) instanceof JsonInvoiceStore);
        assert.ok(app.get(HTTP_ERRAND_STORE) instanceof JsonErrandStore);
        assert.ok(app.get(HTTP_BUSINESS_SETTINGS_STORE) instanceof JsonBusinessSettingsStore);
        assert.ok(app.get(HTTP_QUOTE_STORE) instanceof JsonQuoteStore);
        assert.ok(app.get(HTTP_QUOTE_REPOSITORY) instanceof ConvexQuoteRepository);
        assert.ok(app.get(HTTP_BUILD_STORE) instanceof ConvexBuildStore);
        assert.ok(app.get(HTTP_BUILD_LOG_STORE) instanceof ConvexBuildLogStore);
        assert.ok(app.get(HTTP_UPGRADE_STORE) instanceof ConvexUpgradeStore);
        assert.ok(app.get(HTTP_ASSET_STORE) instanceof ConvexAssetStore);
        assert.ok(app.get(HTTP_PREFERENCE_STORE) instanceof ConvexPreferenceStore);
      } finally {
        await app.close();
      }
    });
  });

  it("refuses export-v4 when the provider is Convex and writes no archive", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jarvis-lv1-09-export-"));
    const target = path.join(directory, "archive.json");
    try {
      await withConvexProviderEnv(async () => {
        assert.throws(
          () => resolveJsonSourceConfig("convex"),
          (error: unknown) =>
            error instanceof StrictBackupError &&
            /PERSISTENCE_PROVIDER selects "convex"/.test(error.message),
        );
        await assert.rejects(
          exportArchiveV4File(target),
          (error: unknown) =>
            error instanceof StrictBackupError &&
            /PERSISTENCE_PROVIDER selects "convex"/.test(error.message),
        );
      });
      await assert.rejects(
        stat(target),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses full recovery when quoteAggregate is absent", () => {
    const present = ARCHIVE_GROUPS.filter((group) => group !== "quoteAggregate");
    const manifest = buildManifest({
      createdAt: AT,
      groups: present.map((group) => entry(group)),
      verification: verificationFor(present),
    });
    assert.equal(manifest.completeness, "partial");
    assert.ok(manifest.coverage.absent.includes("quoteAggregate"));
    assert.throws(
      () => assertRecoverable(manifest),
      (error: unknown) =>
        error instanceof ArchiveManifestError &&
        /Refusing full recovery from a partial archive/.test(error.message) &&
        /quoteAggregate/.test(error.message),
    );
  });

  it("keeps clients and invoices out of a classic backup archive", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jarvis-lv1-09-classic-"));
    try {
      const archive = await exportBackup(
        new JSONPersistence(path.join(directory, "state.json")),
        () => AT,
        {
          builds: new JsonBuildStore(path.join(directory, "builds.json")),
          buildLogs: new JsonBuildLogStore(path.join(directory, "build-logs.json")),
          upgrades: new JsonUpgradeStore(path.join(directory, "upgrades.json")),
          assets: new JsonAssetStore(path.join(directory, "assets.json")),
          preferences: new JsonPreferenceStore(path.join(directory, "preferences.json")),
        },
      );
      assert.deepEqual(Object.keys(archive).sort(), [
        "assets",
        "buildLogs",
        "builds",
        "createdAt",
        "format",
        "preferences",
        "reminders",
        "state",
        "tasks",
        "upgrades",
        "version",
      ]);
      assert.equal("clients" in archive, false);
      assert.equal("invoices" in archive, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
