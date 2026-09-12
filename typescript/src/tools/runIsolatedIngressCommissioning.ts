import { loadEnvFile } from "node:process";

import {
  purgeCommissioningRuns,
  startCommissioningBootstrap,
} from "../commissioning/isolatedIngress/index.js";
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
      "  npm run commission:isolated-ingress                       # start the loopback OIDC probe listener",
      "  npm run commission:isolated-ingress -- cleanup <campaignId> <runId> [runId...]",
      "",
      "Prerequisites: an approved development JARVIS_OIDC_* configuration, a deployed",
      "development CONVEX_URL/JARVIS_SERVICE_TOKEN, and JARVIS_HTTP_HOST left on a",
      "loopback address. This starts NO business adapters and executes only a",
      "read-only probe. Merging the bootstrap clears no live gate.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const [command, campaignId, ...runIds] = process.argv.slice(2);

  if (command === "cleanup") {
    if (!campaignId || runIds.length === 0) usage();
    const result = await purgeCommissioningRuns({}, { campaignId, runIds });
    console.log(
      `Commissioning cleanup for campaign ${result.campaignId}: deleted ${result.deleted.length} run(s) ` +
        `(${result.deleted.reduce((sum, run) => sum + run.steps, 0)} step(s), ` +
        `${result.deleted.reduce((sum, run) => sum + run.reconciliations, 0)} reconciliation(s)); ` +
        `${result.notFound.length} run id(s) not found.`,
    );
    return;
  }

  if (command !== undefined) usage();

  const bootstrap = await startCommissioningBootstrap();
  console.log("Isolated-ingress commissioning listener started.");
  for (const [key, value] of Object.entries(bootstrap.summary)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log(`  endpoint: POST ${bootstrap.url}`);
  console.log("Send Idempotency-Key + a Bearer OIDC access token. Ctrl-C to stop.");

  const shutdown = () => {
    void bootstrap.app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(
    "Isolated-ingress commissioning failed:",
    redactSecret(error, process.env.JARVIS_SERVICE_TOKEN),
  );
  process.exitCode = 1;
});
