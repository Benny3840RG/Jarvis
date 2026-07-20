// Shared types for the isolated agent simulation subsystem.
//
// This subsystem is a self-contained, in-memory SIMULATION of a governed
// autonomous orchestrator (workshop / business / home). It does not persist,
// does not touch the maintained task/reminder runtime, and its "safety" checks
// are simulation rules — not real-world PPE or hazard enforcement.

/** An untyped-at-the-edge payload; individual engines narrow the fields they need. */
export type Payload = Record<string, unknown>;

/** Reads a string field from a payload, or returns the fallback. */
export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Reads a numeric field from a payload, or returns the fallback. */
export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
