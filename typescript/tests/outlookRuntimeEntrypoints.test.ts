import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createQuoteEmailProviderFromEnv } from "../src/quotes/quoteEmailProvider.js";

const enabledEnvironment = {
  JARVIS_OUTLOOK_ENABLED: "true",
  JARVIS_OUTLOOK_CLIENT_ID: "client-id",
  JARVIS_OUTLOOK_MAILBOX: "thebeeztreez@outlook.com",
  JARVIS_OUTLOOK_REFRESH_TOKEN_FILE: "/run/secrets/jarvis-outlook-refresh-token",
} as const;

describe("Outlook process composition", () => {
  it("keeps the quote provider disabled unless Outlook is explicitly enabled", () => {
    assert.equal(createQuoteEmailProviderFromEnv({}), null);
    assert.equal(
      createQuoteEmailProviderFromEnv(enabledEnvironment)?.name,
      "microsoft-graph-mail-v1",
    );
  });

  it("shares one Outlook runtime across sending and reconciliation in maintained entrypoints", async () => {
    for (const relativePath of ["../src/http/main.ts", "../src/preview/main.ts"]) {
      const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
      assert.match(source, /const outlookRuntime = createMicrosoftOutlookRuntimeFromEnv\(\);/u);
      assert.match(source, /createOutlookRuntimeReconciliationFactories\(outlookRuntime\)/u);
      assert.match(
        source,
        /createToolExecutionServiceFromEnv\(outlookRuntime\?\.quoteEmailProvider\)/u,
      );
      assert.match(source, /toolExecutionService,/u);
    }
  });
});
