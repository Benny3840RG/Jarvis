import "reflect-metadata";

import type { IncomingMessage } from "node:http";

import type { NestApplicationOptions } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { createToolActionServiceFromEnv } from "../actions/toolActionFactory.js";
import type { ToolActionService } from "../actions/toolActions.js";
import { createToolExecutionServiceFromEnv } from "../actions/toolExecutionFactory.js";
import type { ToolExecutionService } from "../actions/toolExecution.js";
import type { ClientStore } from "../clients/client.js";
import { InMemoryClientStore } from "../clients/inMemoryClientStore.js";
import { JsonClientStore } from "../clients/jsonClientStore.js";
import type { ProjectStore } from "../projects/project.js";
import { InMemoryProjectStore } from "../projects/inMemoryProjectStore.js";
import { JsonProjectStore } from "../projects/jsonProjectStore.js";
import type { QuoteStore } from "../quotes/quote.js";
import { InMemoryQuoteStore } from "../quotes/inMemoryQuoteStore.js";
import { JsonQuoteStore } from "../quotes/jsonQuoteStore.js";
import { createQuoteRepositoryFromEnv } from "../quotes/quoteRepositoryFactory.js";
import { createQuoteDeliveryRepositoryFromEnv } from "../quotes/quoteDeliveryRepositoryFactory.js";
import type { QuoteDeliveryRepository } from "../quotes/quoteDeliveryRepository.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import type { ErrandStore } from "../errands/errand.js";
import { InMemoryErrandStore } from "../errands/inMemoryErrandStore.js";
import { JsonErrandStore } from "../errands/jsonErrandStore.js";
import type { BuildStore } from "../builds/build.js";
import { InMemoryBuildStore } from "../builds/inMemoryBuildStore.js";
import { JsonBuildStore } from "../builds/jsonBuildStore.js";
import { ConvexBuildStore } from "../builds/convexBuildStore.js";
import type { BuildLogStore } from "../buildLog/buildLogEntry.js";
import { InMemoryBuildLogStore } from "../buildLog/inMemoryBuildLogStore.js";
import { JsonBuildLogStore } from "../buildLog/jsonBuildLogStore.js";
import { ConvexBuildLogStore } from "../buildLog/convexBuildLogStore.js";
import type { UpgradeStore } from "../upgrades/upgrade.js";
import { InMemoryUpgradeStore } from "../upgrades/inMemoryUpgradeStore.js";
import { JsonUpgradeStore } from "../upgrades/jsonUpgradeStore.js";
import { ConvexUpgradeStore } from "../upgrades/convexUpgradeStore.js";
import type { AssetStore } from "../assets/asset.js";
import { InMemoryAssetStore } from "../assets/inMemoryAssetStore.js";
import { JsonAssetStore } from "../assets/jsonAssetStore.js";
import { ConvexAssetStore } from "../assets/convexAssetStore.js";
import type { PreferenceStore } from "../preferences/preference.js";
import { InMemoryPreferenceStore } from "../preferences/inMemoryPreferenceStore.js";
import { JsonPreferenceStore } from "../preferences/jsonPreferenceStore.js";
import { ConvexPreferenceStore } from "../preferences/convexPreferenceStore.js";
import type { NoteStore } from "../notes/note.js";
import { InMemoryNoteStore } from "../notes/inMemoryNoteStore.js";
import { ConvexNoteStore } from "../persistence/convexNotes.js";
import { createMemoryChangeSetServiceFromEnv } from "../memory/memoryChangeSetFactory.js";
import type { MemoryChangeSetService } from "../memory/memoryChangeSets.js";
import { createActivityEventReaderFromEnv } from "../operations/activityTimelineFactory.js";
import type { ActivityEventReader } from "../operations/activityTimeline.js";
import {
  createPersistenceFromEnv,
  resolvePersistenceProviderName,
  type PersistenceProvider,
  type PersistenceProviderName,
} from "../persistence/persistence.js";
import { createTotalityPipelineFromEnv } from "../totality/totalityFactory.js";
import type { TotalityPipeline } from "../totality/totalityPipeline.js";
import { ConvexExternalReconciliationStore } from "../persistence/convexExternalReconciliations.js";
import type { ExternalReconciliationReadStore } from "../reconciliation/externalReconciliation.js";
import type { RuntimeReconciliationHealth } from "../reconciliation/runtimeReconciliationHost.js";
import { resolveHttpAppConfig, type HttpAppConfig } from "./config.js";
import { JarvisHttpModule } from "./jarvisHttpModule.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./requestId.js";

type DefaultPersistenceOptions = {
  persistence?: never;
  providerName?: never;
};

type InjectedPersistenceOptions = {
  persistence: PersistenceProvider;
  providerName: PersistenceProviderName;
};

export type RegisteredRoute = { method: string; url: string };

export type CreateJarvisHttpAppOptions = (
  DefaultPersistenceOptions | InjectedPersistenceOptions
) & {
  config?: HttpAppConfig;
  reconciliationHealth?: () => RuntimeReconciliationHealth;
  externalReconciliationReadStore?: ExternalReconciliationReadStore | null;
  logger?: NestApplicationOptions["logger"];
  totalityPipeline?: TotalityPipeline | null;
  memoryChangeSetService?: MemoryChangeSetService | null;
  toolActionService?: ToolActionService | null;
  toolExecutionService?: ToolExecutionService | null;
  clientStore?: ClientStore;
  projectStore?: ProjectStore;
  quoteStore?: QuoteStore;
  quoteRepository?: QuoteRepository | null;
  quoteDeliveryRepository?: QuoteDeliveryRepository | null;
  errandStore?: ErrandStore;
  buildStore?: BuildStore;
  buildLogStore?: BuildLogStore;
  upgradeStore?: UpgradeStore;
  assetStore?: AssetStore;
  preferenceStore?: PreferenceStore;
  noteStore?: NoteStore;
  activityEventReader?: ActivityEventReader | null;
  /**
   * Invoked once per Fastify route as it is registered. Exposed so contract
   * tests can enumerate the routes the app actually serves without parsing the
   * formatted `printRoutes` tree. The `url` is in Fastify `:param` form.
   */
  onRoute?: (route: RegisteredRoute) => void;
};

/**
 * Chooses a durable-memory store. An injected store always wins (tests). With a
 * real environment the provider decides: Convex when configured, JSON otherwise.
 * Without an environment (an injected core persistence, i.e. tests) the store is
 * in-memory so nothing touches disk or a deployment.
 */
function selectMemoryStore<T>(
  injected: T | undefined,
  usesEnvironment: boolean,
  providerName: PersistenceProviderName,
  make: { json: () => T; convex: () => T; inMemory: () => T },
): T {
  if (injected !== undefined) return injected;
  if (!usesEnvironment) return make.inMemory();
  return providerName === "convex" ? make.convex() : make.json();
}

export async function createJarvisHttpApp(
  options: CreateJarvisHttpAppOptions = {},
): Promise<NestFastifyApplication> {
  if ((options.persistence === undefined) !== (options.providerName === undefined)) {
    throw new Error("Injected HTTP persistence requires its explicit provider name.");
  }
  const providerName = options.providerName ?? resolvePersistenceProviderName();
  const persistence = options.persistence ?? createPersistenceFromEnv();
  const config = options.config ?? resolveHttpAppConfig();
  const usesEnvironment = options.persistence === undefined;
  const reconciliationHealth =
    options.reconciliationHealth ?? (() => ({ state: "disabled", enabled: false }));
  const externalReconciliationReadStore =
    options.externalReconciliationReadStore !== undefined
      ? options.externalReconciliationReadStore
      : usesEnvironment && providerName === "convex"
        ? new ConvexExternalReconciliationStore()
        : null;
  const totalityPipeline =
    options.totalityPipeline !== undefined
      ? options.totalityPipeline
      : usesEnvironment
        ? createTotalityPipelineFromEnv()
        : null;
  const memoryChangeSetService =
    options.memoryChangeSetService !== undefined
      ? options.memoryChangeSetService
      : usesEnvironment
        ? createMemoryChangeSetServiceFromEnv()
        : null;
  const toolActionService =
    options.toolActionService !== undefined
      ? options.toolActionService
      : usesEnvironment
        ? createToolActionServiceFromEnv()
        : null;
  const toolExecutionService =
    options.toolExecutionService !== undefined
      ? options.toolExecutionService
      : usesEnvironment
        ? createToolExecutionServiceFromEnv()
        : null;
  const activityEventReader =
    options.activityEventReader !== undefined
      ? options.activityEventReader
      : usesEnvironment
        ? createActivityEventReaderFromEnv()
        : null;
  const clientStore =
    options.clientStore ?? (usesEnvironment ? new JsonClientStore() : new InMemoryClientStore());
  const projectStore =
    options.projectStore ?? (usesEnvironment ? new JsonProjectStore() : new InMemoryProjectStore());
  const quoteStore =
    options.quoteStore ?? (usesEnvironment ? new JsonQuoteStore() : new InMemoryQuoteStore());
  const quoteRepository =
    options.quoteRepository !== undefined
      ? options.quoteRepository
      : usesEnvironment
        ? createQuoteRepositoryFromEnv()
        : null;
  const quoteDeliveryRepository =
    options.quoteDeliveryRepository !== undefined
      ? options.quoteDeliveryRepository
      : usesEnvironment
        ? createQuoteDeliveryRepositoryFromEnv()
        : null;
  const errandStore =
    options.errandStore ?? (usesEnvironment ? new JsonErrandStore() : new InMemoryErrandStore());
  const buildStore = selectMemoryStore(options.buildStore, usesEnvironment, providerName, {
    json: () => new JsonBuildStore(),
    convex: () => new ConvexBuildStore(),
    inMemory: () => new InMemoryBuildStore(),
  });
  const buildLogStore = selectMemoryStore(options.buildLogStore, usesEnvironment, providerName, {
    json: () => new JsonBuildLogStore(),
    convex: () => new ConvexBuildLogStore(),
    inMemory: () => new InMemoryBuildLogStore(),
  });
  const upgradeStore = selectMemoryStore(options.upgradeStore, usesEnvironment, providerName, {
    json: () => new JsonUpgradeStore(),
    convex: () => new ConvexUpgradeStore(),
    inMemory: () => new InMemoryUpgradeStore(),
  });
  const assetStore = selectMemoryStore(options.assetStore, usesEnvironment, providerName, {
    json: () => new JsonAssetStore(),
    convex: () => new ConvexAssetStore(),
    inMemory: () => new InMemoryAssetStore(),
  });
  const preferenceStore = selectMemoryStore(
    options.preferenceStore,
    usesEnvironment,
    providerName,
    {
      json: () => new JsonPreferenceStore(),
      convex: () => new ConvexPreferenceStore(),
      inMemory: () => new InMemoryPreferenceStore(),
    },
  );
  // Notes have no JSON-file store: per the AM-003 commissioning plan (issue
  // #150), notes use only the Convex-backed persistence boundary in any real
  // deployment, so this always uses Convex when an environment is present
  // rather than following PERSISTENCE_PROVIDER like the other memory stores.
  const noteStore =
    options.noteStore ?? (usesEnvironment ? new ConvexNoteStore() : new InMemoryNoteStore());
  const adapter = new FastifyAdapter({
    genReqId: (request: IncomingMessage) =>
      resolveRequestId(request.headers[REQUEST_ID_HEADER], [
        config.currentToken,
        config.previousToken,
      ]),
  });
  if (options.onRoute) {
    const collect = options.onRoute;
    adapter.getInstance().addHook("onRoute", (routeOptions) => {
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method];
      for (const method of methods) collect({ method, url: routeOptions.url });
    });
  }
  const app = await NestFactory.create<NestFastifyApplication>(
    JarvisHttpModule.register({
      persistence,
      providerName,
      config,
      reconciliationHealth,
      externalReconciliationReadStore,
      totalityPipeline,
      memoryChangeSetService,
      toolActionService,
      toolExecutionService,
      clientStore,
      projectStore,
      quoteStore,
      quoteRepository,
      quoteDeliveryRepository,
      errandStore,
      buildStore,
      buildLogStore,
      upgradeStore,
      assetStore,
      preferenceStore,
      noteStore,
      activityEventReader,
    }),
    adapter,
    { logger: options.logger, abortOnError: false },
  );

  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
