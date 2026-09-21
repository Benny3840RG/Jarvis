import { createInterface } from "node:readline/promises";

import { JsonQuoteStore } from "../quotes/jsonQuoteStore.js";
import { runCreateQuote } from "../quoting/createQuote.js";

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const store = new JsonQuoteStore();
  await runCreateQuote(
    {
      question: (prompt: string) => rl.question(prompt),
      close: () => {
        rl.close();
      },
    },
    (line: string) => {
      console.log(line);
    },
    {},
    store,
  );
}

main().catch((error: unknown) => {
  console.error(`Quote intake failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
