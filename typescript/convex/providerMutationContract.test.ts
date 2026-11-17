import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { ConvexPersistence, type ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexControlledTaskStore } from "../src/persistence/convexControlledTasks.js";
import {
  harnessCapabilities,
  providerMutationContract,
  type ContractHarness,
} from "../tests/contracts/providerMutationContract.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "provider-contract-service-token-0000000000";
const WRONG_TOKEN = "provider-contract-wrong-token-00000000000000";

// The production provider classes run unchanged over convex-test, so the
// contract exercises the same client code paths used against a deployment.
function harness(): ContractHarness {
  const client = convexTest(schema, modules) as unknown as ConvexClientLike;
  return {
    provider: new ConvexPersistence(client, SERVICE_TOKEN),
    controlledTasks: new ConvexControlledTaskStore(client, SERVICE_TOKEN),
    unauthorisedProvider: new ConvexPersistence(client, WRONG_TOKEN),
  };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider mutation contract: Convex", () => {
  const declared = harnessCapabilities(harness());
  for (const contractCase of providerMutationContract) {
    it.skipIf(!declared.has(contractCase.requires))(contractCase.name, async () => {
      await contractCase.run(harness());
    });
  }
});
