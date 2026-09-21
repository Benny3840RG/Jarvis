import { JsonQuoteStore } from "../quotes/jsonQuoteStore.js";
import { findQuoteRecordByNumber } from "../quoting/quoteRecordStore.js";
import { renderQuoteText } from "../quoting/quoteRenderer.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const quoteNumber = Number(arg);
  if (!arg || !Number.isFinite(quoteNumber)) {
    console.error("Usage: npm run quotes:show -- <quoteNumber>");
    process.exitCode = 1;
    return;
  }

  const store = new JsonQuoteStore();
  const quote = await findQuoteRecordByNumber(store, quoteNumber);
  if (!quote) {
    console.error(`Jarvis: No quote #${quoteNumber} found.`);
    process.exitCode = 1;
    return;
  }

  console.log(renderQuoteText(quote));
}

main().catch((error: unknown) => {
  console.error(`Showing quote failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
