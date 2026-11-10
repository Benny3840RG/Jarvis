/**
 * Scores the natural-language intent interpreter (#567, Wave One) against the
 * same frozen dataset used for the exact-matcher baseline, so the coverage
 * improvement is measured like-for-like and the safety set is re-checked.
 *
 * Pure. The interpreter only ever PROPOSES; this scorer classifies proposals
 * against the labels exactly as the parser scorer does, so "before" (parser)
 * and "after" (interpreter) are directly comparable.
 */

import { interpretIntent } from "../../src/voice/voiceIntentInterpreter.js";
import { VOICE_COMMANDS, type VoiceDispatchKind } from "../../src/voice/voiceCommands.js";
import {
  VOICE_INTENT_DATASET,
  VOICE_INTENT_DATASET_VERSION,
  type EvalCase,
  type IntentCategory,
} from "./voiceIntentDataset.js";
import { type CoverageSlice, formatPct } from "./voiceIntentScoring.js";

const COMMAND_KIND: ReadonlyMap<string, VoiceDispatchKind> = new Map(
  VOICE_COMMANDS.map((command) => [command.id, command.kind]),
);

export type InterpCaseResult = Readonly<{
  case: EvalCase;
  status: "proposed" | "needs-clarification" | "no-intent";
  proposedCommandId: string | null;
  verdict: "correct" | "missed" | "wrong-match" | "withheld" | "leaked";
  unsafeActuation: boolean;
}>;

function scoreCase(testCase: EvalCase): InterpCaseResult {
  const intent = interpretIntent({
    transcript: testCase.transcript,
    profile: testCase.profile,
    isFinal: testCase.isFinal,
    ...(testCase.alternatives ? { alternatives: testCase.alternatives } : {}),
  });

  const proposedCommandId = intent.status === "proposed" ? intent.commandId : null;
  const kind = proposedCommandId ? (COMMAND_KIND.get(proposedCommandId) ?? null) : null;

  let verdict: InterpCaseResult["verdict"];
  if (testCase.expectedCommandId === null) {
    verdict = proposedCommandId === null ? "withheld" : "leaked";
  } else if (proposedCommandId === testCase.expectedCommandId) {
    verdict = "correct";
  } else if (proposedCommandId === null) {
    verdict = "missed";
  } else {
    verdict = "wrong-match";
  }

  const unsafeActuation = (verdict === "wrong-match" || verdict === "leaked") && kind === "actuate";
  return Object.freeze({
    case: testCase,
    status: intent.status,
    proposedCommandId,
    verdict,
    unsafeActuation,
  });
}

export type InterpreterReport = Readonly<{
  datasetVersion: string | null;
  results: readonly InterpCaseResult[];
  naturalCoverage: CoverageSlice;
  naturalCoverageDev: CoverageSlice;
  naturalCoverageHeldOut: CoverageSlice;
  canonicalCoverage: CoverageSlice;
  wrongMatches: readonly InterpCaseResult[];
  safetyLeaks: readonly InterpCaseResult[];
  unsafeActuations: readonly InterpCaseResult[];
  byCategory: ReadonlyMap<
    IntentCategory,
    { total: number; correct: number; withheld: number; leaked: number; wrongMatch: number }
  >;
}>;

function coverage(label: string, results: readonly InterpCaseResult[]): CoverageSlice {
  const total = results.length;
  const correct = results.filter((r) => r.verdict === "correct").length;
  return { label, total, correct, rate: total === 0 ? 0 : correct / total };
}

const NATURAL: ReadonlySet<IntentCategory> = new Set(["informal-au", "asr-error"]);

export function evaluateInterpreter(
  dataset: readonly EvalCase[] = VOICE_INTENT_DATASET,
): InterpreterReport {
  const results = dataset.map(scoreCase);
  const natural = results.filter((r) => NATURAL.has(r.case.category));

  const byCategory = new Map<
    IntentCategory,
    { total: number; correct: number; withheld: number; leaked: number; wrongMatch: number }
  >();
  for (const r of results) {
    const t = byCategory.get(r.case.category) ?? {
      total: 0,
      correct: 0,
      withheld: 0,
      leaked: 0,
      wrongMatch: 0,
    };
    t.total += 1;
    if (r.verdict === "correct") t.correct += 1;
    if (r.verdict === "withheld") t.withheld += 1;
    if (r.verdict === "leaked") t.leaked += 1;
    if (r.verdict === "wrong-match") t.wrongMatch += 1;
    byCategory.set(r.case.category, t);
  }

  return Object.freeze({
    datasetVersion: dataset === VOICE_INTENT_DATASET ? VOICE_INTENT_DATASET_VERSION : null,
    results,
    naturalCoverage: coverage("natural (informal + asr)", natural),
    naturalCoverageDev: coverage(
      "natural — dev",
      natural.filter((r) => !r.case.heldOut),
    ),
    naturalCoverageHeldOut: coverage(
      "natural — held-out",
      natural.filter((r) => r.case.heldOut),
    ),
    canonicalCoverage: coverage(
      "canonical",
      results.filter((r) => r.case.category === "canonical"),
    ),
    wrongMatches: Object.freeze(results.filter((r) => r.verdict === "wrong-match")),
    // Count every leaked verdict, not only those in the safety/ambiguous set,
    // so any command proposed when none was intended is always surfaced.
    safetyLeaks: Object.freeze(results.filter((r) => r.verdict === "leaked")),
    unsafeActuations: Object.freeze(results.filter((r) => r.unsafeActuation)),
    byCategory,
  });
}

export { formatPct };
