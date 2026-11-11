/**
 * Voice-intent baseline — reproducible evaluation + safety regression guard (#567).
 *
 * This is the executable half of the Wave One preparation evidence. It does two
 * things, both deterministic:
 *
 *   1. SAFETY INVARIANTS (the part that must never regress). Across every
 *      adversarial case the guarded parser must fail closed — interim
 *      transcripts never dispatch, a command phrase embedded in a longer
 *      sentence never matches, a phrase under the wrong profile never matches,
 *      conflicting recogniser hypotheses are rejected as ambiguous, and no
 *      utterance ever resolves to the wrong command or actuates when none was
 *      intended.
 *
 *   2. BASELINE LOCK (the reproducible deficiency). The current exact-match
 *      parser serves 0 of the natural-phrasing cases. Locking that number makes
 *      the coverage gap a tracked, regression-tested fact and ensures a future
 *      natural-language layer is measured against a frozen baseline — and that
 *      any accidental loosening of exact matching is caught here.
 *
 * The parser under test is pure; there is no model call and the numbers are
 * stable. See `docs/evidence/voice-intent-baseline-2026-11-10.md`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { VOICE_COMMANDS, VOICE_PROFILES } from "../src/voice/voiceCommands.js";
import { buildMarkdown } from "./support/generateVoiceIntentReport.js";
import { VOICE_INTENT_DATASET } from "./support/voiceIntentDataset.js";
import { evaluate } from "./support/voiceIntentScoring.js";

const report = evaluate();
const CATALOG_IDS = new Set(VOICE_COMMANDS.map((c) => c.id));

describe("voice-intent dataset integrity", () => {
  it("every labelled intent names a real catalog command", () => {
    for (const testCase of VOICE_INTENT_DATASET) {
      if (testCase.expectedCommandId !== null) {
        assert.ok(
          CATALOG_IDS.has(testCase.expectedCommandId),
          `${testCase.id}: unknown command ${testCase.expectedCommandId}`,
        );
      }
    }
  });

  it("every case uses a valid profile and a unique id", () => {
    const ids = new Set<string>();
    for (const testCase of VOICE_INTENT_DATASET) {
      assert.ok(VOICE_PROFILES.includes(testCase.profile), `${testCase.id}: bad profile`);
      assert.ok(!ids.has(testCase.id), `duplicate case id ${testCase.id}`);
      ids.add(testCase.id);
    }
  });
});

describe("voice-intent SAFETY invariants — must fail closed", () => {
  it("interim (non-final) transcripts never dispatch, even exact phrases", () => {
    const interim = report.results.filter((r) => r.case.category === "safety-interim");
    assert.ok(interim.length > 0);
    for (const r of interim) assert.equal(r.status, "pending-final", r.case.id);
  });

  it("a command phrase embedded in a longer sentence never matches (no substring smuggling)", () => {
    const sub = report.results.filter((r) => r.case.category === "safety-substring");
    assert.ok(sub.length > 0);
    for (const r of sub) assert.notEqual(r.status, "recognized", r.case.id);
  });

  it("a valid phrase under the wrong active profile never matches", () => {
    const xp = report.results.filter((r) => r.case.category === "safety-cross-profile");
    assert.ok(xp.length > 0);
    for (const r of xp) assert.notEqual(r.status, "recognized", r.case.id);
  });

  it("conflicting recogniser hypotheses are rejected as ambiguous", () => {
    const amb = report.results.filter((r) => r.case.category === "safety-ambiguous");
    assert.ok(amb.length > 0);
    for (const r of amb) assert.equal(r.status, "ambiguous", r.case.id);
  });

  it("no utterance resolves to the WRONG command", () => {
    assert.deepEqual(
      report.wrongMatches.map((r) => r.case.id),
      [],
    );
  });

  it("no command leaks when no command was intended", () => {
    assert.deepEqual(
      report.safetyLeaks.map((r) => r.case.id),
      [],
    );
  });

  it("no actuate command ever fires for a wrong or absent intent", () => {
    assert.deepEqual(
      report.unsafeActuations.map((r) => r.case.id),
      [],
    );
    assert.equal(report.unsafeActuations.length, 0);
  });
});

describe("voice-intent baseline lock — the reproducible coverage gap", () => {
  it("canonical anchors all recognise (dataset labels agree with the live catalog)", () => {
    assert.equal(report.canonicalCoverage.total, 41);
    assert.equal(report.canonicalCoverage.correct, 41);
  });

  it("the exact-match parser serves 0 of 69 natural-phrasing cases today", () => {
    assert.equal(report.naturalCoverage.total, 69);
    assert.equal(report.naturalCoverage.correct, 0);
    assert.equal(report.naturalCoverage.rate, 0);
  });

  it("held-out and dev splits both measure the same zero baseline", () => {
    assert.equal(report.naturalCoverageHeldOut.correct, 0);
    assert.equal(report.naturalCoverageDev.correct, 0);
    assert.ok(report.naturalCoverageHeldOut.total > 0, "held-out split is non-empty");
  });

  it("locks the per-category tallies so the baseline is a tracked fact", () => {
    const tally = Object.fromEntries(report.byCategory.map((t) => [t.category, t]));
    assert.equal(tally["canonical"]?.correct, 41);
    assert.equal(tally["informal-au"]?.total, 57);
    assert.equal(tally["informal-au"]?.missed, 57);
    assert.equal(tally["asr-error"]?.total, 12);
    assert.equal(tally["asr-error"]?.missed, 12);
    assert.equal(tally["ambiguous-intent"]?.withheld, 5);
    assert.equal(report.safetyCasesTotal, 16);
  });
});

describe("voice-intent evaluation failure accounting", () => {
  const status = VOICE_INTENT_DATASET.find((item) => item.id === "can-crawler-status")!;

  it("counts a non-actuating match on an ambiguous intent as a safety leak", () => {
    const result = evaluate([{ ...status, category: "ambiguous-intent", expectedCommandId: null }]);
    assert.equal(result.unsafeActuations.length, 0);
    assert.equal(result.safetyLeaks.length, 1);
    assert.equal(result.safetyLeaks[0]?.resolvedCommandId, "crawler.status");
  });

  it("reports a wrong non-actuating match as unsafe, not as a declined utterance", () => {
    const result = evaluate([
      { ...status, category: "informal-au", expectedCommandId: "crawler.forward" },
    ]);
    const markdown = buildMarkdown(result);
    assert.equal(result.wrongMatches.length, 1);
    assert.equal(result.unsafeActuations.length, 0);
    assert.match(markdown, /NON-ZERO/);
    assert.match(markdown, /Coverage gap on natural phrasing:.*0\/1/);
    assert.doesNotMatch(markdown, /all zero|Zero\*\* unsafe/);
  });
});

describe("voice-intent report provenance", () => {
  it("regenerates the archived evidence byte for byte from this checkout", () => {
    const archived = readFileSync(
      new URL("../../docs/evidence/voice-intent-baseline-2026-11-10.md", import.meta.url),
      "utf8",
    );
    const generated = buildMarkdown(evaluate());
    assert.equal(generated === archived, true, "the committed evidence must reproduce");
  });

  it("does not assign the canonical version to a custom dataset", () => {
    const custom = evaluate([]);
    assert.equal(custom.datasetVersion, null);
    assert.match(buildMarkdown(custom), /Dataset version \| custom \(unversioned\)/);
    assert.notEqual(evaluate().datasetVersion, null);
  });
});
