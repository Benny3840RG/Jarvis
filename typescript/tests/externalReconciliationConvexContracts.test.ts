import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const schemaSource = ["../convex/schema.ts", "../convex/schemaBase.ts"]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");
const reconciliationSource = readFileSync(
  new URL("../convex/externalReconciliations.ts", import.meta.url),
  "utf8",
);

describe("external reconciliation Convex contracts", () => {
  it("defines the required reconciliation indexes", () => {
    assert.ok(schemaSource.includes('index("by_owner_and_scope"'));
    assert.ok(schemaSource.includes('index("by_owner_and_state_and_next_attempt_at"'));
    assert.ok(schemaSource.includes('index("by_owner_and_state_and_lease_expires_at"'));
    assert.ok(schemaSource.includes('index("by_owner_and_receipt_key"'));
  });

  it("uses bounded indexed lookups instead of unbounded scans", () => {
    assert.equal(reconciliationSource.includes(".collect("), false);
    assert.equal(reconciliationSource.includes(".filter("), false);
    assert.ok(reconciliationSource.includes('withIndex("by_owner_and_scope"'));
    assert.ok(reconciliationSource.includes('withIndex("by_owner_and_state_and_next_attempt_at"'));
    assert.ok(reconciliationSource.includes('withIndex("by_owner_and_state_and_lease_expires_at"'));
    assert.ok(reconciliationSource.includes(".unique()"));
    assert.ok(reconciliationSource.includes(".first()"));
  });

  it("guards resolution and release with exact, unexpired lease ownership", () => {
    assert.ok(reconciliationSource.includes('record.state !== "claimed"'));
    assert.ok(reconciliationSource.includes("record.leaseOwner !== workerId"));
    assert.ok(reconciliationSource.includes("record.leaseToken !== leaseToken"));
    assert.ok(reconciliationSource.includes("record.leaseExpiresAt === undefined"));
    assert.ok(reconciliationSource.includes("record.leaseExpiresAt <= now"));
    assert.equal(
      reconciliationSource.split("assertLease(reconciliation, workerId, leaseToken, args.now)")
        .length - 1,
      2,
    );
  });

  it("updates the authoritative receipt and queue record in one mutation", () => {
    assert.ok(
      reconciliationSource.includes(
        'ctx.db.replace("toolExecutionReceipts", receipt._id, replacement)',
      ),
    );
    assert.ok(
      reconciliationSource.includes(
        'ctx.db.patch("externalReconciliations", reconciliation._id, {\n      state: "resolved"',
      ),
    );
    assert.ok(reconciliationSource.includes('errorCode: "provider-failed" as const'));
  });

  it("restricts cleanup to the authorised development deployment", () => {
    assert.ok(reconciliationSource.includes('args.deployment !== "dev:outgoing-ram-798"'));
    assert.ok(reconciliationSource.includes('ctx.db.delete("toolExecutionReceipts", receipt._id)'));
    assert.ok(
      reconciliationSource.includes('ctx.db.delete("externalReconciliations", reconciliation._id)'),
    );
  });
});
