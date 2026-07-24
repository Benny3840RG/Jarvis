import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const schemaSource = readFileSync(new URL("../convex/schema.ts", import.meta.url), "utf8");
const quotesSource = readFileSync(new URL("../convex/quotes.ts", import.meta.url), "utf8");

describe("quote Convex contracts", () => {
  it("defines owner-first quote aggregate and revision indexes", () => {
    for (const indexName of [
      "by_owner_and_quote_id",
      "by_owner_and_number",
      "by_owner_and_client_id",
      "by_owner_and_project_id",
      "by_owner_quote_and_revision",
      "by_owner_and_revision_id",
      "by_owner_quote_and_status",
      "by_owner_and_fingerprint",
    ]) {
      assert.ok(schemaSource.includes(`index("${indexName}"`), `missing ${indexName}`);
    }
  });

  it("uses bounded indexed reads without table scans", () => {
    assert.equal(quotesSource.includes(".collect("), false);
    assert.equal(quotesSource.includes(".filter("), false);
    assert.ok(quotesSource.includes('withIndex("by_owner_and_quote_id"'));
    assert.ok(quotesSource.includes('withIndex("by_owner_and_number"'));
    assert.ok(quotesSource.includes('withIndex("by_owner_quote_and_revision"'));
    assert.ok(quotesSource.includes(".unique()"));
    assert.ok(quotesSource.includes(".take("));
  });

  it("exposes controlled authenticated functions only", () => {
    for (const functionName of [
      "create",
      "get",
      "list",
      "updateDraft",
      "submitForReview",
      "reopenForEditing",
      "finalizeRevision",
      "forkRevision",
      "recordCommercialOutcome",
      "cleanupDevelopmentQuote",
    ]) {
      assert.ok(quotesSource.includes(`export const ${functionName} =`), `missing ${functionName}`);
    }
    assert.ok(quotesSource.includes("serviceToken: v.string()"));
    assert.ok(quotesSource.includes("requireOwner(args.serviceToken)"));
    assert.equal(quotesSource.includes("status: v.string()"), false);
  });

  it("creates aggregate and first revision in one mutation", () => {
    assert.ok(quotesSource.includes('ctx.db.insert("quotes"'));
    assert.ok(quotesSource.includes('ctx.db.insert("quoteRevisions"'));
    assert.ok(quotesSource.includes("buildInitialQuoteRecords"));
  });

  it("finalizes and forks through authoritative atomic writes", () => {
    assert.ok(quotesSource.includes("finalizeQuoteRevision"));
    assert.ok(quotesSource.includes('ctx.db.replace("quoteRevisions"'));
    assert.ok(quotesSource.includes("forkFinalizedQuote"));
    assert.ok(quotesSource.includes('ctx.db.insert("quoteRevisions"'));
    assert.ok(quotesSource.includes('ctx.db.replace("quotes"'));
  });

  it("restricts destructive cleanup to the authorised development deployment", () => {
    assert.ok(quotesSource.includes('args.deployment !== "dev:outgoing-ram-798"'));
    assert.ok(quotesSource.includes('ctx.db.delete("quoteRevisions"'));
    assert.ok(quotesSource.includes('ctx.db.delete("quotes"'));
  });
});
