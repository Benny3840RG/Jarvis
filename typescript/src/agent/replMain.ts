import { createInterface } from "node:readline/promises";

import { createPersistenceFromEnv } from "../persistence/persistence.js";
import { createAgentSystem } from "./system.js";
import { runAgentRepl } from "./repl.js";

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const persistence = createPersistenceFromEnv();
  const system = createAgentSystem({ persistence });
  await runAgentRepl(
    {
      question: (prompt: string) => rl.question(prompt),
      close: () => {
        rl.close();
      },
    },
    (line: string) => {
      console.log(line);
    },
    system,
  );
}

main().catch((error: unknown) => {
  console.error(`Agent REPL failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
