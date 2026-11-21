import { loadEnvFile } from "node:process";

import { processRunningExecutions } from "../actions/runningExecutions.js";
import { createToolExecutionServiceFromEnv } from "../actions/toolExecutionFactory.js";
import { jarvisDataFile } from "../persistence/jarvisDataPaths.js";
import { FileHaltStore, HALT_FILE_BASENAME } from "../security/haltControl.js";
import {
  FileHaltAckStore,
  HALT_ACK_FILE_BASENAME,
  HaltSupervisor,
} from "../security/haltSupervisor.js";
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

  // `nolan sec halt` (#839): cancels this process's running governed tool
  // executions while halted, and reports acknowledged / verified stopped.
  const haltSupervisor = new HaltSupervisor(
    new FileHaltStore(jarvisDataFile(HALT_FILE_BASENAME)),
    new FileHaltAckStore(jarvisDataFile(HALT_ACK_FILE_BASENAME)),
    processRunningExecutions,
    { onError: () => console.error("Security halt acknowledgement could not be written.") },
  );
  haltSupervisor.start();

  try {
    await app.listen(listen);
    await reconciliation.start();
  } catch (error: unknown) {
    await haltSupervisor.stop();
    await reconciliation.stop();
    await app.close();
    throw error;
  }

  console.log(`Jarvis HTTP is listening on http://${listen.host}:${listen.port}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await haltSupervisor.stop();
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
