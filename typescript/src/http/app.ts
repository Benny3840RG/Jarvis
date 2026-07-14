import "reflect-metadata";

import type { IncomingMessage } from "node:http";

import type { NestApplicationOptions } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

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

export type CreateJarvisHttpAppOptions = (
  DefaultPersistenceOptions | InjectedPersistenceOptions
) & {
  config?: HttpAppConfig;
  logger?: NestApplicationOptions["logger"];
  totalityPipeline?: TotalityPipeline | null;
};

export async function createJarvisHttpApp(
  options: CreateJarvisHttpAppOptions = {},
): Promise<NestFastifyApplication> {
  if ((options.persistence === undefined) !== (options.providerName === undefined)) {
    throw new Error("Injected HTTP persistence requires its explicit provider name.");
  }
  const providerName = options.providerName ?? resolvePersistenceProviderName();
  const persistence = options.persistence ?? createPersistenceFromEnv();
  const config = options.config ?? resolveHttpAppConfig();
  const totalityPipeline =
    options.totalityPipeline !== undefined
      ? options.totalityPipeline
      : options.persistence === undefined
        ? createTotalityPipelineFromEnv()
        : null;
  const adapter = new FastifyAdapter({
    genReqId: (request: IncomingMessage) =>
      resolveRequestId(request.headers[REQUEST_ID_HEADER], [
        config.currentToken,
        config.previousToken,
      ]),
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    JarvisHttpModule.register({ persistence, providerName, config, totalityPipeline }),
    adapter,
    { logger: options.logger, abortOnError: false },
  );

  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
