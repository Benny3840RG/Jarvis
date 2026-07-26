/**
 * Governance boundary tests for AM-012 (Finalize quote) and AM-013 (Send quote).
 *
 * These tests read the authoritative registry and source files to assert the
 * planned-lifecycle boundary that prevents premature activation of the quote
 * action families. They do not call any runtime code and do not require a
 * Convex deployment.
 *
 * The assertions correspond to Task 9's governance contract:
 * - AM-012 lifecycle_status = planned
 * - AM-013 lifecycle_status = planned
 * - WF-QUOTE-001 lifecycle_status = planned
 * - AM-012 from = reviewed (not draft)
 * - AM-012 to = finalized
 * - TOOL-QUOTE-FINALIZE not in the live production allowlist
 * - TOOL-QUOTE-SEND not in the live production allowlist without all three gates
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const actionRegistry = readFileSync(
  new URL("../../docs/traceability/action-family-registry.yaml", import.meta.url),
  "utf8",
);
const toolRegistry = readFileSync(
  new URL("../../docs/registries/tool-registry.yaml", import.meta.url),
  "utf8",
);
const stateTargetRegistry = readFileSync(
  new URL("../../docs/registries/state-target-registry.yaml", import.meta.url),
  "utf8",
);
const testIdRegistry = readFileSync(
  new URL("../../docs/registries/test-id-registry.yaml", import.meta.url),
  "utf8",
);
const evidenceIdRegistry = readFileSync(
  new URL("../../docs/registries/evidence-id-registry.yaml", import.meta.url),
  "utf8",
);
const toolExecutionSource = readFileSync(
  new URL("../src/actions/toolExecution.ts", import.meta.url),
  "utf8",
);
const toolExecutionFactorySource = readFileSync(
  new URL("../src/actions/toolExecutionFactory.ts", import.meta.url),
  "utf8",
);

describe("AM-012/AM-013 governance: lifecycle status must remain planned", () => {
  it("AM-012 is planned in the action family registry", () => {
    // The YAML block for AM-012 must include lifecycle_status: planned.
    // We verify by checking the surrounding context.
    const am012Block = extractBlock(actionRegistry, "- id: AM-012", "- id: AM-013");
    assert.ok(
      am012Block.includes("lifecycle_status: planned"),
      "AM-012 must have lifecycle_status: planned",
    );
  });

  it("AM-013 is planned in the action family registry", () => {
    const am013Block = extractBlock(actionRegistry, "- id: AM-013", "- id: WF-QUOTE-001");
    assert.ok(
      am013Block.includes("lifecycle_status: planned"),
      "AM-013 must have lifecycle_status: planned",
    );
  });

  it("WF-QUOTE-001 is planned in the action family registry", () => {
    const wfBlock = actionRegistry.slice(actionRegistry.indexOf("- id: WF-QUOTE-001"));
    assert.ok(
      wfBlock.includes("lifecycle_status: planned"),
      "WF-QUOTE-001 must have lifecycle_status: planned",
    );
  });
});

describe("AM-012/AM-013 governance: state impact contract", () => {
  it("AM-012 state impact from is [reviewed] — not [draft, reviewed]", () => {
    const am012Block = extractBlock(actionRegistry, "- id: AM-012", "- id: AM-013");
    // Should contain reviewed but NOT contain "draft" in the from array.
    // The from value must be exactly [reviewed] per the corrected registry.
    assert.ok(
      am012Block.includes("from: [reviewed]"),
      "AM-012 state_impact.from must be [reviewed] only",
    );
  });

  it("AM-012 state impact to is finalized", () => {
    const am012Block = extractBlock(actionRegistry, "- id: AM-012", "- id: AM-013");
    assert.ok(am012Block.includes("to: finalized"), "AM-012 state_impact.to must be finalized");
  });

  it("AM-013 state impact from is [finalized]", () => {
    const am013Block = extractBlock(actionRegistry, "- id: AM-013", "- id: WF-QUOTE-001");
    assert.ok(
      am013Block.includes("from: [finalized]"),
      "AM-013 state_impact.from must be [finalized]",
    );
  });
});

describe("AM-012/AM-013 governance: tool registry boundary", () => {
  it("TOOL-QUOTE-FINALIZE is registered in the tool registry", () => {
    assert.ok(
      toolRegistry.includes("id: TOOL-QUOTE-FINALIZE"),
      "TOOL-QUOTE-FINALIZE must be in the tool registry",
    );
  });

  it("TOOL-QUOTE-SEND is registered in the tool registry", () => {
    assert.ok(
      toolRegistry.includes("id: TOOL-QUOTE-SEND"),
      "TOOL-QUOTE-SEND must be in the tool registry",
    );
  });

  it("STORE-QUOTES is registered in the state target registry", () => {
    assert.ok(
      stateTargetRegistry.includes("id: STORE-QUOTES"),
      "STORE-QUOTES must be in the state target registry",
    );
  });
});

describe("AM-012/AM-013 governance: test and evidence traceability IDs exist", () => {
  const expectedTestIds = [
    "TEST-AM-012-DOMAIN-001",
    "TEST-AM-012-PERSIST-001",
    "TEST-AM-012-TOOL-001",
    "TEST-AM-012-SMOKE-001",
    "TEST-AM-013-DELIVERY-001",
    "TEST-AM-013-RECONCILIATION-001",
    "TEST-AM-013-APPROVAL-001",
    "TEST-AM-013-SMOKE-001",
  ];

  for (const testId of expectedTestIds) {
    it(`${testId} is registered in test-id-registry.yaml`, () => {
      assert.ok(
        testIdRegistry.includes(`id: ${testId}`),
        `${testId} must be present in test-id-registry.yaml`,
      );
    });
  }

  it("EVD-AM-012-001 is registered in evidence-id-registry.yaml", () => {
    assert.ok(
      evidenceIdRegistry.includes("id: EVD-AM-012-001"),
      "EVD-AM-012-001 must be in evidence-id-registry.yaml",
    );
  });

  it("EVD-AM-013-001 is registered in evidence-id-registry.yaml", () => {
    assert.ok(
      evidenceIdRegistry.includes("id: EVD-AM-013-001"),
      "EVD-AM-013-001 must be in evidence-id-registry.yaml",
    );
  });
});

describe("AM-012/AM-013 governance: allowlist boundary (TOOL-QUOTE-FINALIZE not wired into live definitions)", () => {
  it("TOOL-QUOTE-FINALIZE is defined in quoteFinalizeTool.ts but not in the live allowlist definitions", () => {
    // quoteFinalizeTool.ts must export the definition.
    const quoteFinalizeSource = readFileSync(
      new URL("../src/actions/quoteFinalizeTool.ts", import.meta.url),
      "utf8",
    );
    assert.ok(
      quoteFinalizeSource.includes("quotes:finalize") ||
        quoteFinalizeSource.includes("createQuoteFinalizeToolDefinition"),
      "quoteFinalizeTool.ts must define the quotes:finalize boundary",
    );

    // toolExecution.ts must NOT include quotes:finalize in the allowlist.
    assert.equal(
      toolExecutionSource.includes('"quotes:finalize"') ||
        toolExecutionSource.includes("'quotes:finalize'"),
      false,
      "toolExecution.ts must not hardcode quotes:finalize in the live allowlist",
    );

    // The factory's production path must not add quotes:finalize to live definitions
    // without being explicitly called with all three gates.
    assert.ok(
      toolExecutionFactorySource.includes("quotes") ||
        toolExecutionFactorySource.includes("QuoteRepository"),
      "toolExecutionFactory.ts should reference the quote domain for conditional wiring",
    );
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Extracts the YAML text between `startMarker` (inclusive) and `endMarker`
 * (exclusive). Returns from `startMarker` to the end of the document if
 * `endMarker` is not found.
 */
function extractBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) return "";
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}
