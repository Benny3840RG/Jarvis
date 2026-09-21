import {
  PerplexityClient,
  resolvePerplexityConfig,
} from "../integrations/perplexity/perplexityClient.js";

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error('Usage: npm run search -- "<query>"');
    process.exitCode = 1;
    return;
  }

  const client = new PerplexityClient(resolvePerplexityConfig());
  const result = await client.search(query);

  console.log(result.answer);
  if (result.citations.length > 0) {
    console.log("\nSources:");
    for (const citation of result.citations) {
      console.log(`- ${citation}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(`Search failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
