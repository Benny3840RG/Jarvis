import "reflect-metadata";

import type { IncomingMessage } from "node:http";

import type { NestApplicationOptions } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { createToolActionServiceFromEnv } from "../actions/toolActionFactory.js";
import type { ToolActionService } from "../actions/toolActions.js";
import type { ClientStore } from "../clients/client.js";
import { InMemoryClientStore } from "../clients/inMemoryClientStore.js";
import { JsonClientStore } from "../clients/jsonClientStore.js";
import type { ProjectStore } from "../projects/project.js";
import { InMemoryProjectStore } from "../projects/inMemoryProjectStore.js";
import { JsonProjectStore } from "../projects/jsonProjectStore.js";
import type { QuoteStore } from "../quotes/quote.js";
import { InMemoryQuoteStore } from "../quotes/inMemoryQuoteStore.js";
import { JsonQuoteStore } from "../quotes/jsonQuoteStore.js";
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
import type { AssetStore } from "../assets/asset.js";
import { InMemoryAssetStore } from "../assets/inMemoryAssetStore.js";
import { JsonAssetStore } from "../assets/jsonAssetStore.js";
import type { PreferenceStore } from "../preferences/preference.js";
import { InMemoryPreferenceStore } from "../preferences/inMemoryPreferenceStore.js";
import { JsonPreferenceStore } from "../preferences/jsonPreferenceStore.js";
import { createMemoryChangeSetServiceFromEnv } from "../memory/memoryChangeSetFactory.js";
import type { MemoryChangeSetService } from "../memory/memoryChangeSets.js";
import {
  createPersistenceFromEnv,
  resolvePersistenceProviderName,
  type PersistenceProvider,
  type PersistenceProviderName,
} from "../persistence/persistence.js";
import { createTotalityPipelineFromEnv } from "../totality/totalityFactory.js";
import type { TotalityPipeline } from "../totality/totalityPipeline.js";
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
  logger?: NestApplicationOptions["logger"];
  totalityPipeline?: TotalityPipeline | null;
  memoryChangeSetService?: MemoryChangeSetService | null;
  toolActionService?: ToolActionService | null;
  clientStore?: ClientStore;
  projectStore?: ProjectStore;
  quoteStore?: QuoteStore;
  errandStore?: ErrandStore;
  buildStore?: BuildStore;
  buildLogStore?: BuildLogStore;
  upgradeStore?: UpgradeStore;
  assetStore?: AssetStore;
  preferenceStore?: PreferenceStore;
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
  const clientStore =
    options.clientStore ?? (usesEnvironment ? new JsonClientStore() : new InMemoryClientStore());
  const projectStore =
    options.projectStore ?? (usesEnvironment ? new JsonProjectStore() : new InMemoryProjectStore());
  const quoteStore =
    options.quoteStore ?? (usesEnvironment ? new JsonQuoteStore() : new InMemoryQuoteStore());
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
  const upgradeStore =
    options.upgradeStore ?? (usesEnvironment ? new JsonUpgradeStore() : new InMemoryUpgradeStore());
  const assetStore =
    options.assetStore ?? (usesEnvironment ? new JsonAssetStore() : new InMemoryAssetStore());
  const preferenceStore =
    options.preferenceStore ??
    (usesEnvironment ? new JsonPreferenceStore() : new InMemoryPreferenceStore());
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
      totalityPipeline,
      memoryChangeSetService,
      toolActionService,
      clientStore,
      projectStore,
      quoteStore,
      errandStore,
      buildStore,
      buildLogStore,
      upgradeStore,
      assetStore,
      preferenceStore,
    }),
    adapter,
    { logger: options.logger, abortOnError: false },
  );

  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
