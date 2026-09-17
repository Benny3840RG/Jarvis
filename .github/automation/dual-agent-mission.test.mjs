import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceMission,
  claimMission,
  renderMissionReceipt,
} from "./dual-agent-mission.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const fingerprint = "c".repeat(64);
const identity = { pullNumber: 42, headSha, baseSha, fingerprint };

test("claims a complementary builder and reviewer from available executors", () => {
  const mission = claimMission({
    issueNumber: 42,
    baseSha,
    availableExecutors: ["codex"],
  });

  assert.equal(mission.builder, "codex");
  assert.equal(mission.reviewer, "codex-independent");
  assert.equal(mission.phase, "claimed");
  assert.throws(
    () => claimMission({ issueNumber: 42, baseSha: "short" }),
    /base SHA/,
  );
});

test("alternates to Claude only when its builder executor is available", () => {
  const mission = claimMission({
    issueNumber: 43,
    baseSha,
    previousTerminalBuilder: "codex",
    availableExecutors: ["codex", "claude"],
  });

  assert.equal(mission.builder, "claude");
  assert.equal(mission.reviewer, "codex-independent");
});

test("blocks rather than silently substituting an unavailable selected builder", () => {
  const mission = claimMission({
    issueNumber: 43,
    baseSha,
    previousTerminalBuilder: "codex",
    availableExecutors: ["codex"],
  });

  assert.equal(mission.phase, "blocked");
  assert.match(mission.reason, /Claude builder executor is unavailable/);
});

test("binds review to the exact candidate and returns repairs to the same builder", () => {
  const claimed = claimMission({
    issueNumber: 42,
    baseSha,
    availableExecutors: ["codex"],
  });
  const waiting = advanceMission(claimed, { type: "candidate", ...identity });
  const reviewing = advanceMission(waiting, {
    type: "review-started",
    ...identity,
  });

  assert.throws(
    () =>
      advanceMission(reviewing, {
        type: "repair-required",
        ...identity,
        headSha: "d".repeat(40),
        builder: "codex",
      }),
    /stale/i,
  );
  assert.throws(
    () =>
      advanceMission(reviewing, {
        type: "repair-required",
        ...identity,
        builder: "claude",
      }),
    /original builder/i,
  );
  const repairing = advanceMission(reviewing, {
    type: "repair-required",
    ...identity,
    builder: "codex",
  });
  assert.equal(repairing.phase, "repair-required");
  assert.equal(repairing.repairCount, 1);
});

test("only reaches owner decision after exact clean review and never grants authority", () => {
  const claimed = claimMission({
    issueNumber: 42,
    baseSha,
    availableExecutors: ["codex"],
  });
  const waiting = advanceMission(claimed, { type: "candidate", ...identity });
  const reviewing = advanceMission(waiting, {
    type: "review-started",
    ...identity,
  });
  const owner = advanceMission(reviewing, {
    type: "awaiting-owner",
    ...identity,
  });
  const receipt = renderMissionReceipt(owner);

  assert.equal(owner.phase, "awaiting-owner");
  assert.match(receipt, /Review: advisory/);
  assert.match(
    receipt,
    /Owner interrupts: merge approval, deployment approval, or blocked ambiguity\/risk/,
  );
  assert.match(receipt, /Merge authorised: NO/);
  assert.match(receipt, /Deployment authorised: NO/);
  assert.doesNotMatch(receipt, /Merge authorised: YES|Deployment authorised: YES/);
});
