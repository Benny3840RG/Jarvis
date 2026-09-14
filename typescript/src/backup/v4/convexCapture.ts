import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { canonicalJson } from "../../actions/canonicalJson.js";
import { sha256Hex } from "../../actions/sha256.js";

/** S4 contract inventory; raw capture is not restored group coverage. */
export const S4_TABLES = [
  "projects",
  "projectRecords",
  "notes",
  "developmentEvents",
  "developmentSubjects",
  "runtimeEvents",
  "toolActions",
  "toolExecutionReceipts",
  "memoryChangeSets",
  "auditEvents",
  "validationReports",
  "externalReconciliations",
  "omegaMissions",
  "omegaActionContracts",
  "omegaEvidence",
  "omegaValidationProofs",
  "omegaContradictionResolutions",
] as const;
export type S4Table = (typeof S4_TABLES)[number];
export const S4_CAPTURE_VERSION = "archive-v4-s4-capture:v1";
export const S4_MAX_TOTAL_ROWS = 2000;
export const S4_MAX_PAYLOAD_BYTES = 512 * 1024;

function equalValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof ArrayBuffer || b instanceof ArrayBuffer) {
    if (!(a instanceof ArrayBuffer) || !(b instanceof ArrayBuffer)) return false;
    const left = new Uint8Array(a),
      right = new Uint8Array(b);
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = Object.keys(a).sort(),
    right = Object.keys(b).sort();
  return (
    left.length === right.length &&
    left.every(
      (key, index) =>
        key === right[index] &&
        equalValues((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/** Use the provider's tagged encoding, then verify it preserved every source value. */
export function encodeS4Payload(value: Value): { payloadJson: string; payloadSha256: string } {
  let payloadJson: string;
  try {
    payloadJson = canonicalJson(convexToJson(value));
    if (!equalValues(value, jsonToConvex(JSON.parse(payloadJson))))
      throw new Error("Lossy encoding");
  } catch {
    throw new Error("S4 capture contains a value that cannot be encoded losslessly.");
  }
  if (new TextEncoder().encode(payloadJson).length > S4_MAX_PAYLOAD_BYTES)
    throw new Error("S4 capture exceeds its payload byte limit.");
  return { payloadJson, payloadSha256: sha256Hex(payloadJson) };
}
