import { JsonQuoteStore } from "../quotes/jsonQuoteStore.js";
import { listRecentQuoteRecords } from "../quoting/quoteRecordStore.js";
import { formatCurrency } from "../quoting/quoteRenderer.js";

async function main(): Promise<void> {
  const store = new JsonQuoteStore();
  const summaries = await listRecentQuoteRecords(store, 20);

  if (summaries.length === 0) {
    console.log("Jarvis: No quotes saved yet.");
    return;
  }

  for (const summary of summaries) {
    console.log(
      `#${summary.quoteNumber}  ${summary.clientName} — ${summary.project}  ${formatCurrency(
        summary.totalIncGst,
      )}  ${summary.issueDate}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(`Listing quotes failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
