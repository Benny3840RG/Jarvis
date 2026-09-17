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

test("accepts a repaired candidate only on the original pull request", () => {
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
  const repairing = advanceMission(reviewing, {
    type: "repair-required",
    ...identity,
    builder: "codex",
  });
  const repaired = {
    ...identity,
    headSha: "d".repeat(40),
    fingerprint: "e".repeat(64),
  };

  assert.equal(
    advanceMission(repairing, { type: "candidate", ...repaired }).phase,
    "waiting-ci",
  );
  assert.throws(
    () =>
      advanceMission(repairing, {
        type: "candidate",
        ...repaired,
        pullNumber: 99,
      }),
    /original pull request/i,
  );
  assert.throws(
    () =>
      advanceMission(repairing, {
        type: "candidate",
        ...repaired,
        baseSha: "f".repeat(40),
      }),
    /base SHA/i,
  );
});

test("returns a changed reviewed candidate to CI and caps repairs at two", () => {
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
  const changed = {
    ...identity,
    headSha: "d".repeat(40),
    fingerprint: "e".repeat(64),
  };

  assert.equal(
    advanceMission(reviewing, { type: "candidate", ...changed }).phase,
    "waiting-ci",
  );
  const firstRepair = advanceMission(reviewing, {
    type: "repair-required",
    ...identity,
    builder: "codex",
  });
  const secondWaiting = advanceMission(firstRepair, {
    type: "candidate",
    ...changed,
  });
  const secondReview = advanceMission(secondWaiting, {
    type: "review-started",
    ...changed,
  });
  const secondRepair = advanceMission(secondReview, {
    type: "repair-required",
    ...changed,
    builder: "codex",
  });
  const third = {
    ...changed,
    headSha: "f".repeat(40),
    fingerprint: "0".repeat(64),
  };
  const thirdWaiting = advanceMission(secondRepair, {
    type: "candidate",
    ...third,
  });
  const thirdReview = advanceMission(thirdWaiting, {
    type: "review-started",
    ...third,
  });

  assert.equal(secondRepair.repairCount, 2);
  assert.throws(
    () =>
      advanceMission(thirdReview, {
        type: "repair-required",
        ...third,
        builder: "codex",
      }),
    /repair budget/i,
  );
});

test("allows the owner to terminate a mission from every active phase", () => {
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
  const repairing = advanceMission(reviewing, {
    type: "repair-required",
    ...identity,
    builder: "codex",
  });

  for (const mission of [claimed, waiting, reviewing, repairing]) {
    assert.equal(advanceMission(mission, { type: "terminal" }).phase, "terminal");
  }
});

test("rejects malformed persisted mission state before advancing or rendering", () => {
  const claimed = claimMission({
    issueNumber: 42,
    baseSha,
    availableExecutors: ["codex"],
  });
  const waiting = advanceMission(claimed, { type: "candidate", ...identity });

  for (const mission of [
    { ...claimed, version: 2 },
    { ...claimed, issueNumber: 0 },
    { ...claimed, baseSha: "invalid" },
    { ...claimed, builder: "unknown" },
    { ...claimed, reviewer: "claude" },
    { ...claimed, repairCount: -1 },
    { ...claimed, repairCount: 3 },
    { ...claimed, phase: "unknown" },
    { ...waiting, identity: undefined },
    { ...waiting, identity: { ...identity, baseSha: "d".repeat(40) } },
  ]) {
    assert.throws(() => advanceMission(mission, { type: "terminal" }), /Invalid mission state/);
    assert.throws(() => renderMissionReceipt(mission), /Invalid mission state/);
  }
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
  assert.throws(
    () => advanceMission(reviewing, { type: "awaiting-owner", ...identity }),
    /clean review and trusted CI/i,
  );
  const owner = advanceMission(reviewing, {
    type: "awaiting-owner",
    ...identity,
    ci: "trusted-success",
    review: "clean",
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

test("renders the precise blocked reason for the owner", () => {
  const blocked = advanceMission(
    claimMission({ issueNumber: 42, baseSha, availableExecutors: ["codex"] }),
    { type: "blocked", reason: "Base moved; independently validate a reset." },
  );

  assert.match(renderMissionReceipt(blocked), /Base moved; independently validate a reset\./);
});
