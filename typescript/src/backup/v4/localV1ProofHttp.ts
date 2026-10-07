import type { BuildStore } from "../../builds/build.js";
import type { ClientStore } from "../../clients/client.js";
import { createJarvisHttpApp } from "../../http/app.js";
import type { PersistenceProvider } from "../../persistence/persistence.js";
import type { QuoteRepository } from "../../quotes/quoteRepository.js";
import { assertIsolatedReadsMatch, LocalV1ProofError, type IsolatedRead } from "./localV1Proof.js";

/**
 * Opens two HTTP apps on the same isolated stores and requires the four GETs to match.
 * Kept out of `localV1Proof.ts` so the Convex project does not load the Nest app.
 */
export async function rereadIsolatedHttp(options: {
  persistence: PersistenceProvider;
  clientStore: ClientStore;
  buildStore: BuildStore;
  quoteRepository: QuoteRepository;
  ids: IsolatedRead;
}): Promise<IsolatedRead> {
  assertIsolatedReadsMatch(options.ids, options.ids);
  const urls = [
    `/api/v1/clients/${options.ids.clientId}`,
    `/api/v1/tasks/${options.ids.taskId}`,
    `/api/v1/builds/${options.ids.buildId}`,
    `/api/v1/quotes/${options.ids.quoteId}`,
  ];
  async function once(): Promise<string> {
    const app = await createJarvisHttpApp({
      persistence: options.persistence,
      providerName: "json",
      config: {
        version: "0.1.0",
        sourceVersion: "local-v1-proof",
        deploymentVersion: null,
        timezone: "Australia/Melbourne",
        currentToken: "current-secret",
      },
      logger: false,
      clientStore: options.clientStore,
      buildStore: options.buildStore,
      quoteRepository: options.quoteRepository,
    });
    try {
      const bodies: string[] = [];
      for (const url of urls) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { authorization: "Bearer current-secret" },
        });
        if (response.statusCode !== 200) {
          throw new LocalV1ProofError(`Local V1 proof HTTP read failed for ${url}.`);
        }
        bodies.push(response.body);
      }
      return bodies.join("\n");
    } finally {
      await app.close();
    }
  }
  const first = await once();
  const second = await once();
  if (first !== second) {
    throw new LocalV1ProofError("Local V1 proof restart did not match the first read.");
  }
  return options.ids;
}
