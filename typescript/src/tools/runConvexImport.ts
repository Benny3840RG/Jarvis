import { loadEnvFile } from "node:process";

import { ConvexAssetStore } from "../assets/convexAssetStore.js";
import { JsonAssetStore } from "../assets/jsonAssetStore.js";
import { ConvexBuildLogStore } from "../buildLog/convexBuildLogStore.js";
import { JsonBuildLogStore } from "../buildLog/jsonBuildLogStore.js";
import { ConvexBuildStore } from "../builds/convexBuildStore.js";
import { JsonBuildStore } from "../builds/jsonBuildStore.js";
import { importMemoryStores, type MemoryStoreBundle } from "../importer/importMemoryStores.js";
import { ConvexPreferenceStore } from "../preferences/convexPreferenceStore.js";
import { JsonPreferenceStore } from "../preferences/jsonPreferenceStore.js";
import { ConvexUpgradeStore } from "../upgrades/convexUpgradeStore.js";
import { JsonUpgradeStore } from "../upgrades/jsonUpgradeStore.js";
import { redactSecret } from "./convexSmoke.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npm run import:convex -- --confirm-empty-target",
      "",
      "Copies every JSON-store durable-memory record (builds, build logs,",
      "upgrades, assets, preferences) into the Convex deployment identified by",
      "CONVEX_URL / JARVIS_SERVICE_TOKEN. Refuses to run if the Convex side",
      "already holds any records in one of those five tables.",
      "",
      "Creation timestamps are NOT preserved: migrated records get a fresh",
      "createdAt/updatedAt at import time. occurredAt (build logs, upgrades) is",
      "a normal input field and is carried over.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const [flag, ...extra] = process.argv.slice(2);
  if (flag !== "--confirm-empty-target" || extra.length > 0) usage();

  const source: MemoryStoreBundle = {
    builds: new JsonBuildStore(),
    buildLogs: new JsonBuildLogStore(),
    upgrades: new JsonUpgradeStore(),
    assets: new JsonAssetStore(),
    preferences: new JsonPreferenceStore(),
  };
  const target: MemoryStoreBundle = {
    builds: new ConvexBuildStore(),
    buildLogs: new ConvexBuildLogStore(),
    upgrades: new ConvexUpgradeStore(),
    assets: new ConvexAssetStore(),
    preferences: new ConvexPreferenceStore(),
  };

  const summary = await importMemoryStores(source, target);
  console.log(
    [
      "Convex import complete:",
      `  builds: ${summary.builds}`,
      `  buildLogs: ${summary.buildLogs}`,
      `  upgrades: ${summary.upgrades}`,
      `  assets: ${summary.assets}`,
      `  preferences: ${summary.preferences}`,
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error("Convex import failed:", redactSecret(error, process.env.JARVIS_SERVICE_TOKEN));
  process.exitCode = 1;
});
