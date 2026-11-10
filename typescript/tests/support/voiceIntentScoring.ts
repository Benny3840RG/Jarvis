/**
 * Voice-intent scorer (#567 — Wave One preparation).
 *
 * Pure. Runs the REAL guarded parser (`parseUtterance`) over the evaluation
 * dataset and classifies every outcome. It changes no production behaviour; it
 * only observes the live parser and aggregates separated metrics, as the
 * commission requires: intent accuracy, coverage-gap (clarification) rate and
 * unsafe-assumption rate are reported distinctly, never conflated.
 *
 * Severity note: the parser is exact-match and fail-closed. A natural phrasing
 * it declines is a COVERAGE gap (safe, expected today), not a defect. The only
 * failures that matter for safety are (a) a wrong command resolved for a clear
 * intent, and (b) a command resolved when no command was intended (a leak).
 * Both must be zero.
 */

import { parseUtterance } from "../../src/voice/voiceParser.js";
import { VOICE_COMMANDS, type VoiceDispatchKind } from "../../src/voice/voiceCommands.js";
import {
  VOICE_INTENT_DATASET,
  VOICE_INTENT_DATASET_VERSION,
  type EvalCase,
  type IntentCategory,
} from "./voiceIntentDataset.js";

const COMMAND_KIND: ReadonlyMap<string, VoiceDispatchKind> = new Map(
  VOICE_COMMANDS.map((command) => [command.id, command.kind]),
);

export type CaseResult = Readonly<{
  case: EvalCase;
  status: "recognized" | "no-match" | "empty" | "pending-final" | "ambiguous";
  resolvedCommandId: string | null;
  /** How the resolved outcome scores against the label. */
  verdict: "correct" | "missed" | "wrong-match" | "withheld" | "leaked";
  /** True when an actuate command was resolved for the wrong/none intent. */
  unsafeActuation: boolean;
}>;

function scoreCase(testCase: EvalCase): CaseResult {
  const outcome = parseUtterance({
    transcript: testCase.transcript,
    isFinal: testCase.isFinal,
    profile: testCase.profile,
    ...(testCase.alternatives ? { alternatives: testCase.alternatives } : {}),
  });

  const resolvedCommandId = outcome.status === "recognized" ? outcome.command.id : null;
  const resolvedKind = resolvedCommandId ? (COMMAND_KIND.get(resolvedCommandId) ?? null) : null;

  let verdict: CaseResult["verdict"];
  if (testCase.expectedCommandId === null) {
    // No single command intended: anything but a resolved command is correct.
    verdict = resolvedCommandId === null ? "withheld" : "leaked";
  } else if (resolvedCommandId === testCase.expectedCommandId) {
    verdict = "correct";
  } else if (resolvedCommandId === null) {
    verdict = "missed";
  } else {
    verdict = "wrong-match";
  }

  const unsafeActuation =
    (verdict === "wrong-match" || verdict === "leaked") && resolvedKind === "actuate";

  return Object.freeze({
    case: testCase,
    status: outcome.status,
    resolvedCommandId,
    verdict,
    unsafeActuation,
  });
}

export type CategoryTally = Readonly<{
  category: IntentCategory;
  total: number;
  correct: number;
  missed: number;
  wrongMatch: number;
  withheld: number;
  leaked: number;
}>;

export type CoverageSlice = Readonly<{
  label: string;
  total: number;
  correct: number;
  /** correct / total, 0..1; 0 when total is 0. */
  rate: number;
}>;

export type EvaluationReport = Readonly<{
  datasetVersion: string | null;
  totalCases: number;
  results: readonly CaseResult[];
  byCategory: readonly CategoryTally[];
  /** Coverage on natural single-intent cases (informal-au + asr-error). */
  naturalCoverage: CoverageSlice;
  naturalCoverageDev: CoverageSlice;
  naturalCoverageHeldOut: CoverageSlice;
  canonicalCoverage: CoverageSlice;
  /** Number of adversarial safety cases (excludes ambiguous-intent examples). */
  safetyCasesTotal: number;
  /** Any recognized command where the label requires withholding. */
  safetyLeaks: readonly CaseResult[];
  /** Any clear intent resolved to the wrong command. */
  wrongMatches: readonly CaseResult[];
  /** Any actuate command resolved for a wrong/none intent. Must be empty. */
  unsafeActuations: readonly CaseResult[];
}>;

function coverage(label: string, results: readonly CaseResult[]): CoverageSlice {
  const total = results.length;
  const correct = results.filter((r) => r.verdict === "correct").length;
  return { label, total, correct, rate: total === 0 ? 0 : correct / total };
}

const NATURAL: ReadonlySet<IntentCategory> = new Set(["informal-au", "asr-error"]);
const SAFETY: ReadonlySet<IntentCategory> = new Set([
  "safety-substring",
  "safety-cross-profile",
  "safety-interim",
  "safety-ambiguous",
]);

export function evaluate(dataset: readonly EvalCase[] = VOICE_INTENT_DATASET): EvaluationReport {
  const results = dataset.map(scoreCase);

  const categories = [...new Set(dataset.map((c) => c.category))];
  const byCategory: CategoryTally[] = categories.map((category) => {
    const inCat = results.filter((r) => r.case.category === category);
    return {
      category,
      total: inCat.length,
      correct: inCat.filter((r) => r.verdict === "correct").length,
      missed: inCat.filter((r) => r.verdict === "missed").length,
      wrongMatch: inCat.filter((r) => r.verdict === "wrong-match").length,
      withheld: inCat.filter((r) => r.verdict === "withheld").length,
      leaked: inCat.filter((r) => r.verdict === "leaked").length,
    };
  });

  const natural = results.filter((r) => NATURAL.has(r.case.category));
  const safetyResults = results.filter((r) => SAFETY.has(r.case.category));

  return Object.freeze({
    datasetVersion: dataset === VOICE_INTENT_DATASET ? VOICE_INTENT_DATASET_VERSION : null,
    totalCases: results.length,
    results,
    byCategory,
    naturalCoverage: coverage("natural (informal + asr)", natural),
    naturalCoverageDev: coverage(
      "natural — dev split",
      natural.filter((r) => !r.case.heldOut),
    ),
    naturalCoverageHeldOut: coverage(
      "natural — held-out split",
      natural.filter((r) => r.case.heldOut),
    ),
    canonicalCoverage: coverage(
      "canonical",
      results.filter((r) => r.case.category === "canonical"),
    ),
    safetyCasesTotal: safetyResults.length,
    safetyLeaks: Object.freeze(results.filter((r) => r.verdict === "leaked")),
    wrongMatches: Object.freeze(results.filter((r) => r.verdict === "wrong-match")),
    unsafeActuations: Object.freeze(results.filter((r) => r.unsafeActuation)),
  });
}

export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
