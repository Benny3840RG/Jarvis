import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const schemaSource = readFileSync(new URL("../convex/schema.ts", import.meta.url), "utf8");
const quotesSource = readFileSync(new URL("../convex/quotes.ts", import.meta.url), "utf8");
const quotePdfArtifactsSource = readFileSync(
  new URL("../convex/quotePdfArtifacts.ts", import.meta.url),
  "utf8",
);
const quoteFinalizationSource = readFileSync(
  new URL("../convex/quoteFinalization.ts", import.meta.url),
  "utf8",
);

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

  it("uses bounded indexed reads without table scans on every caller-facing mutation", () => {
    const cleanupStart = quotesSource.indexOf("export const cleanup = mutation");
    assert.notEqual(cleanupStart, -1, "expected an exported cleanup mutation");
    const callerFacingSource = quotesSource.slice(0, cleanupStart);
    const cleanupSource = quotesSource.slice(cleanupStart);

    assert.equal(callerFacingSource.includes(".collect("), false);
    assert.equal(quotesSource.includes(".filter("), false);
    assert.ok(callerFacingSource.includes('withIndex("by_owner_and_quote_id"'));
    assert.ok(callerFacingSource.includes('withIndex("by_owner_and_number"'));
    assert.ok(callerFacingSource.includes('withIndex("by_owner_quote_and_revision"'));
    assert.ok(callerFacingSource.includes(".unique()"));
    assert.ok(callerFacingSource.includes(".take("));

    // `cleanup` is dev-only (see below). Reads stay owner+quote indexed and
    // go through collectBounded so they fail closed at MAX_OWNER_LIST_RESULTS
    // instead of an unbounded .collect().
    assert.ok(cleanupSource.includes("collectBounded("));
    assert.equal(cleanupSource.includes(".collect("), false);
    assert.ok(cleanupSource.includes('withIndex("by_owner_quote_and_revision"'));
  });

  it("exposes controlled authenticated functions only", () => {
    const functionNames = [
      "create",
      "get",
      "list",
      "updateDraft",
      "submitForReview",
      "reopenForEditing",
      "finalizeRevision",
      "forkRevision",
      "recordCommercialOutcome",
      "cleanup",
    ];
    for (const functionName of functionNames) {
      assert.ok(quotesSource.includes(`export const ${functionName} =`), `missing ${functionName}`);
    }
    assert.ok(quotesSource.includes("serviceToken: v.string()"));
    assert.equal(
      quotesSource.split("requireOwner(args.serviceToken)").length - 1,
      functionNames.length,
    );
    assert.equal(quotesSource.includes("status: v.string()"), false);
  });

  it("creates aggregate and first revision in one mutation", () => {
    assert.ok(quotesSource.includes('ctx.db.insert("quotes"'));
    assert.ok(quotesSource.includes('ctx.db.insert("quoteRevisions"'));
    assert.ok(quotesSource.includes("buildInitialQuoteRecords"));
  });

  it("finalizes with an immutable PDF artefact and forks through authoritative atomic writes", () => {
    assert.ok(quotePdfArtifactsSource.includes("finalizeQuoteRevision"));
    assert.ok(quotePdfArtifactsSource.includes('ctx.db.replace("quoteRevisions"'));
    assert.ok(quotePdfArtifactsSource.includes('ctx.db.replace("quotes"'));
    assert.ok(quotePdfArtifactsSource.includes('ctx.db.insert("quotePdfArtifacts"'));
    assert.ok(
      quotesSource.includes("Quote finalization requires a durable PDF artifact"),
      "legacy mutation must fail closed",
    );
    const storePosition = quoteFinalizationSource.indexOf("ctx.storage.store");
    const commitPosition = quoteFinalizationSource.indexOf("commitFinalization");
    assert.ok(
      storePosition >= 0 && commitPosition > storePosition,
      "PDF must be stored before commit",
    );

    assert.ok(quotesSource.includes("forkFinalizedQuote"));
    assert.ok(quotesSource.includes('ctx.db.insert("quoteRevisions"'));
    assert.ok(quotesSource.includes('ctx.db.replace("quotes"'));
  });

  it("gates destructive cleanup behind the authorised development deployment, never caller-supplied text alone", () => {
    // The old design this guarded against (`cleanupDevelopmentQuote`) trusted
    // a bare caller-supplied deployment string as its only authority check.
    // The current `cleanup` mutation must never regress to that: it re-checks
    // the exact authorised literal server-side, matching
    // `externalReconciliations.cleanup`'s established convention.
    assert.equal(quotesSource.includes("cleanupDevelopmentQuote"), false);

    const cleanupStart = quotesSource.indexOf("export const cleanup = mutation");
    assert.notEqual(cleanupStart, -1, "expected an exported cleanup mutation");
    const cleanupSource = quotesSource.slice(cleanupStart);
    assert.ok(cleanupSource.includes('args.deployment !== "dev:outgoing-ram-798"'));
    assert.ok(cleanupSource.includes("throw new Error("));
    assert.ok(cleanupSource.includes("ctx.storage.delete"));
    assert.ok(cleanupSource.includes('ctx.db.delete("quotePdfArtifacts"'));
    assert.ok(cleanupSource.includes('ctx.db.delete("quoteRevisions"'));
    assert.ok(cleanupSource.includes('ctx.db.delete("quotes"'));
  });
});
