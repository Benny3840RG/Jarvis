import type { S4ProjectNotesSource } from "./s4ProjectNotes.js";

const key = (project: string, id: string) => JSON.stringify([project, id]);

function logical(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function exactKeys(value: object, names: string[]): boolean {
  return (
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
  );
}

function emptyAttributes(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function integerScore(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

/**
 * Closed current component and risk rows.
 *
 * Logical record ids and parent edges are preserved verbatim. This restore does
 * not mint those ids, so it does not use `UuidRemapper`. Convex physical ids
 * stay on the existing table-scoped S4 identity list. A parent string that
 * merely equals a source `_id` is an unresolved logical edge, not a physical
 * id to translate.
 */
export function validateS4ComponentAndRiskRecords(source: S4ProjectNotesSource): void {
  const parents = new Map<
    string,
    { projectKey: string; recordId: string; parent: string | null }
  >();
  for (const row of source.projectRecords) {
    const record = row.record;
    if (row.kind === "component") {
      if (record.kind !== "component") throw new Error("Unsupported component record shape.");
      if (
        !exactKeys(record, [
          "kind",
          "recordId",
          "name",
          "type",
          "status",
          "parentComponentId",
          "attributes",
          "notes",
        ])
      )
        throw new Error("Unsupported component record shape.");
      if (!logical(record.name) || !logical(record.type) || !logical(record.status))
        throw new Error("Component name, type, and status must be canonical.");
      if (typeof record.notes !== "string") throw new Error("Unsupported component record shape.");
      if (!emptyAttributes(record.attributes))
        throw new Error("Component attributes are unclassified and cannot be restored.");
      const parent = record.parentComponentId;
      if (parent !== null && !logical(parent))
        throw new Error("Invalid component parent reference.");
      parents.set(key(row.projectKey, row.recordId), {
        projectKey: row.projectKey,
        recordId: row.recordId,
        parent,
      });
    } else if (row.kind === "risk") {
      if (record.kind !== "risk") throw new Error("Unsupported risk record shape.");
      if (
        !exactKeys(record, [
          "kind",
          "recordId",
          "hazard",
          "likelihood",
          "consequence",
          "controls",
          "residualRisk",
        ])
      )
        throw new Error("Unsupported risk record shape.");
      if (!logical(record.hazard)) throw new Error("Risk hazard is not canonical.");
      if (!integerScore(record.likelihood) || !integerScore(record.consequence))
        throw new Error("Risk likelihood and consequence must be integers from 1 to 5.");
      if (!Array.isArray(record.controls) || record.controls.some((control) => !logical(control)))
        throw new Error("Risk controls must be canonical strings.");
      if (
        record.residualRisk !== "low" &&
        record.residualRisk !== "medium" &&
        record.residualRisk !== "high"
      )
        throw new Error("Unsupported risk record shape.");
    }
  }
  for (const node of parents.values()) {
    if (node.parent !== null && !parents.has(key(node.projectKey, node.parent)))
      throw new Error("Unresolved component parent reference.");
    const seen = new Set<string>();
    let current: string | null = node.recordId;
    while (current !== null) {
      if (seen.has(current)) throw new Error("Component parent cycle is unsupported.");
      seen.add(current);
      const next = parents.get(key(node.projectKey, current));
      if (!next) throw new Error("Unresolved component parent reference.");
      current = next.parent;
    }
  }
}
