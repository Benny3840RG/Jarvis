import { loadEnvFile } from "node:process";

import { createToolExecutionServiceFromEnv } from "../actions/toolExecutionFactory.js";
import { createMicrosoftOutlookRuntimeFromEnv } from "../auth/microsoftOutlookRuntime.js";
import { assertOutlookReconciliationPairing } from "../auth/outlookReconciliationGuard.js";
import { createOutlookRuntimeReconciliationFactories } from "../reconciliation/outlookRuntimeReconciliation.js";
import { createRuntimeReconciliationHost } from "../reconciliation/runtimeReconciliationHost.js";
import {
  createPostHogTelemetryFromEnv,
  createReconciliationTelemetryObserver,
} from "../observability/posthog.js";
import { createJarvisHttpApp } from "./app.js";
import { resolveHttpListenConfig } from "./config.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  assertOutlookReconciliationPairing();
  const listen = resolveHttpListenConfig();
  const outlookRuntime = createMicrosoftOutlookRuntimeFromEnv();
  const telemetry = createPostHogTelemetryFromEnv();
  const reconciliation = createRuntimeReconciliationHost(
    process.env,
    createOutlookRuntimeReconciliationFactories(outlookRuntime, {
      observeCycle: createReconciliationTelemetryObserver(telemetry),
    }),
  );
  const toolExecutionService = createToolExecutionServiceFromEnv(
    outlookRuntime?.quoteEmailProvider,
  );
  const app = await createJarvisHttpApp({
    reconciliationHealth: () => reconciliation.health(),
    toolExecutionService,
    telemetry,
  });

  try {
    await app.listen(listen);
    await reconciliation.start();
  } catch (error: unknown) {
    await reconciliation.stop();
    await app.close();
    throw error;
  }

  console.log(`Jarvis HTTP is listening on http://${listen.host}:${listen.port}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await reconciliation.stop();
    await app.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch(() => {
  console.error(
    "Jarvis HTTP failed to start. Check its provider, token, timezone, host, and port configuration.",
  );
  process.exitCode = 1;
});
