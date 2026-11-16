import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JSONPersistence } from "../src/persistence/persistence.js";
import {
  harnessCapabilities,
  providerMutationContract,
  type ContractHarness,
} from "./contracts/providerMutationContract.js";

// JSON declares no controlled store and no service auth: those cases are
// reported as skipped so the capability gap is visible in test output.
const declared = harnessCapabilities({ provider: new JSONPersistence("/dev/null") });

describe("provider mutation contract: JSON", () => {
  for (const contractCase of providerMutationContract) {
    const missing = !declared.has(contractCase.requires);
    it(
      contractCase.name,
      { skip: missing ? `JSON provider has no ${contractCase.requires} capability` : false },
      async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-contract-"));
        try {
          const harness: ContractHarness = {
            provider: new JSONPersistence(path.join(dir, "state.json")),
          };
          await contractCase.run(harness);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    );
  }
});
