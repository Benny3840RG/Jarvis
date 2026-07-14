from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

memory = ROOT / "typescript/convex/memoryChangeSets.ts"
text = memory.read_text(encoding="utf-8")
text = text.replace(
    '''  normalizeMemoryRecords,
  requirePositiveRevision,
  type MemoryRecord,
''',
    '''  normalizeMemoryRecords,
  requirePositiveRevision,
  sameMemoryProposal,
  type MemoryRecord,
''',
)
old_helper = '''function sameProposal(
  existing: Doc<"memoryChangeSets">,
  input: {
    requestId: string;
    projectKey: string;
    baseRevision: number;
    records: MemoryRecord[];
    rationale: string;
    proposedBy: "user" | "agent" | "tool";
  },
): boolean {
  return (
    existing.requestId === input.requestId &&
    existing.projectKey === input.projectKey &&
    existing.baseRevision === input.baseRevision &&
    existing.rationale === input.rationale &&
    existing.proposedBy === input.proposedBy &&
    JSON.stringify(existing.records) === JSON.stringify(input.records)
  );
}

'''
text = text.replace(old_helper, "")
text = text.replace(
    '''        !sameProposal(existing, {
          requestId,
''',
    '''        !sameMemoryProposal(existing, {
''',
)
memory.write_text(text, encoding="utf-8")

controller = ROOT / "typescript/src/http/memoryChangeSetController.ts"
text = controller.read_text(encoding="utf-8")
text = text.replace(
    "/cannot be|only approved|already exists with different|conflicting|duplicate/i",
    "/cannot be|only approved|already exists with different|already has a different|conflicting|duplicate/i",
)
controller.write_text(text, encoding="utf-8")

doc = ROOT / "typescript/docs/operators/memory-approval.md"
text = doc.read_text(encoding="utf-8")
text = text.replace(
    "- fact confidence is between `0` and `1`;\n",
    "- fact confidence is finite and between `0` and `1`;\n- measurement values are finite;\n",
)
text = text.replace(
    "- fact and decision timestamps are canonical UTC ISO date-times;\n",
    "- fact and decision timestamps are canonical UTC ISO date-times;\n- decisions contain at most 50 rejected alternatives;\n",
)
doc.write_text(text, encoding="utf-8")
