const SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const EXECUTORS = new Set(["codex", "claude"]);
const REVIEWER = "codex-independent";

function exactIdentity(value) {
  if (
    !Number.isSafeInteger(value?.issueNumber) ||
    value.issueNumber < 1 ||
    !Number.isSafeInteger(value?.pullNumber) ||
    value.pullNumber < 1 ||
    !SHA.test(value.headSha) ||
    !SHA.test(value.baseSha) ||
    !FINGERPRINT.test(value.fingerprint)
  ) {
    throw new Error("Invalid exact candidate identity.");
  }
  return {
    issueNumber: value.issueNumber,
    pullNumber: value.pullNumber,
    headSha: value.headSha,
    baseSha: value.baseSha,
    fingerprint: value.fingerprint,
  };
}

function terminalEvidence(value) {
  if (
    value?.actor !== "Benny" ||
    !["merged", "closed", "abandoned"].includes(value.decision)
  ) {
    throw new Error("Terminal transition requires owner evidence.");
  }
  return { actor: value.actor, decision: value.decision };
}

function rolePlan(previousTerminalMission, availableExecutors) {
  const available = new Set(availableExecutors || ["codex"]);
  if (![...available].every((executor) => EXECUTORS.has(executor)))
    throw new Error("Unknown agent executor.");
  let previousBuilder;
  if (previousTerminalMission !== undefined) {
    validateMission(previousTerminalMission);
    if (previousTerminalMission.phase !== "terminal")
      throw new Error("Role rotation requires a terminal mission.");
    previousBuilder = previousTerminalMission.builder;
  }
  const preferred = previousBuilder === "codex" ? "claude" : "codex";
  if (!available.has(preferred)) {
    return {
      builder: preferred,
      reviewer: REVIEWER,
      phase: "blocked",
      reason: `${preferred === "claude" ? "Claude" : "Codex"} builder executor is unavailable.`,
    };
  }
  return {
    builder: preferred,
    reviewer: REVIEWER,
    phase: "claimed",
  };
}

export function claimMission({
  issueNumber,
  baseSha,
  previousTerminalMission,
  availableExecutors,
} = {}) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new Error("Invalid issue number.");
  if (!SHA.test(baseSha)) throw new Error("Invalid base SHA.");
  const roles = rolePlan(previousTerminalMission, availableExecutors);
  return {
    version: 1,
    issueNumber,
    baseSha,
    repairCount: 0,
    ...roles,
  };
}

function sameIdentity(mission, identity) {
  return (
    mission.identity?.issueNumber === identity.issueNumber &&
    mission.identity?.pullNumber === identity.pullNumber &&
    mission.identity?.headSha === identity.headSha &&
    mission.identity?.baseSha === identity.baseSha &&
    mission.identity?.fingerprint === identity.fingerprint
  );
}

function requireCurrentIdentity(mission, event) {
  const identity = exactIdentity(event);
  if (!sameIdentity(mission, identity))
    throw new Error("Stale candidate identity is not eligible for this mission.");
  return identity;
}

const transitions = {
  claimed: new Set(["candidate", "blocked", "terminal"]),
  "waiting-ci": new Set(["review-started", "blocked", "terminal"]),
  reviewing: new Set(["candidate", "repair-required", "awaiting-owner", "blocked", "terminal"]),
  "repair-required": new Set(["candidate", "blocked", "terminal"]),
  "awaiting-owner": new Set(["terminal"]),
  blocked: new Set(["terminal"]),
  terminal: new Set(),
};

function invalidMissionState() {
  throw new Error("Invalid mission state.");
}

function validateMission(mission) {
  if (!mission || typeof mission !== "object" || Array.isArray(mission))
    invalidMissionState();
  if (
    mission.version !== 1 ||
    !Number.isSafeInteger(mission.issueNumber) ||
    mission.issueNumber < 1 ||
    !SHA.test(mission.baseSha) ||
    !EXECUTORS.has(mission.builder) ||
    mission.reviewer !== REVIEWER ||
    !Number.isSafeInteger(mission.repairCount) ||
    mission.repairCount < 0 ||
    mission.repairCount > 2 ||
    !transitions[mission.phase]
  ) {
    invalidMissionState();
  }

  const requiresIdentity = new Set([
    "waiting-ci",
    "reviewing",
    "repair-required",
    "awaiting-owner",
  ]);
  if (requiresIdentity.has(mission.phase) && !mission.identity)
    invalidMissionState();
  if (mission.phase === "claimed" && mission.identity) invalidMissionState();
  if (mission.identity) {
    let identity;
    try {
      identity = exactIdentity(mission.identity);
    } catch {
      invalidMissionState();
    }
    if (identity.issueNumber !== mission.issueNumber || identity.baseSha !== mission.baseSha)
      invalidMissionState();
  }
  if (mission.phase === "terminal") {
    try {
      terminalEvidence(mission.terminalEvidence);
    } catch {
      invalidMissionState();
    }
  } else if (mission.terminalEvidence !== undefined) {
    invalidMissionState();
  }
  return mission;
}

export function advanceMission(mission, event = {}) {
  validateMission(mission);
  if (!transitions[mission.phase].has(event.type))
    throw new Error(`Mission phase ${mission.phase} cannot consume ${event.type}.`);
  if (event.type === "blocked")
    return { ...mission, phase: "blocked", reason: String(event.reason || "Blocked.") };
  if (event.type === "terminal")
    return { ...mission, phase: "terminal", terminalEvidence: terminalEvidence(event.ownerEvidence) };
  if (event.type === "candidate") {
    const identity = exactIdentity(event);
    if (identity.issueNumber !== mission.issueNumber)
      throw new Error("Candidate is not bound to the claimed issue.");
    if (identity.baseSha !== mission.baseSha)
      return {
        ...mission,
        phase: "blocked",
        reason: "Candidate base moved; independently validate a reset before continuing.",
      };
    if (mission.identity && identity.pullNumber !== mission.identity.pullNumber)
      throw new Error("Candidate must remain on the original pull request.");
    if (mission.phase === "repair-required" && sameIdentity(mission, identity))
      throw new Error("Repair must publish a fresh candidate identity.");
    return { ...mission, phase: "waiting-ci", identity };
  }
  const identity = requireCurrentIdentity(mission, event);
  if (event.type === "repair-required") {
    if (event.builder !== mission.builder)
      throw new Error("Repairs must return to the original builder.");
    if (mission.repairCount >= 2)
      throw new Error("Mission repair budget is exhausted.");
    return { ...mission, phase: "repair-required", identity, repairCount: mission.repairCount + 1 };
  }
  if (event.type === "review-started") return { ...mission, phase: "reviewing", identity };
  if (event.type === "awaiting-owner") {
    if (event.ci !== "trusted-success" || event.review !== "clean")
      throw new Error("Owner handoff requires a clean review and trusted CI.");
    return { ...mission, phase: "awaiting-owner", identity };
  }
  throw new Error("Unsupported mission event.");
}

export function renderMissionReceipt(mission) {
  validateMission(mission);
  const candidate = mission.identity
    ? `PR: #${mission.identity.pullNumber}\nCandidate SHA: ${mission.identity.headSha}\nCI fingerprint: ${mission.identity.fingerprint}`
    : "PR: not yet published\nCandidate SHA: not yet published\nCI fingerprint: not yet published";
  return [
    "<!-- jarvis-dual-agent-mission:v1 -->",
    "## Jarvis autonomous mission",
    `Mission: #${mission.issueNumber}`,
    `Phase: ${mission.phase}`,
    `Base SHA: ${mission.baseSha}`,
    candidate,
    `Builder: ${mission.builder}`,
    `Independent reviewer: ${mission.reviewer}`,
    "Review: advisory; not a GitHub approval.",
    ...(mission.phase === "blocked" ? [`Blocked reason: ${mission.reason || "Blocked."}`] : []),
    `Repairs routed to original builder: ${mission.builder} (${mission.repairCount || 0})`,
    "Owner interrupts: merge approval, deployment approval, or blocked ambiguity/risk.",
    "Merge authorised: NO",
    "Deployment authorised: NO",
    "This receipt is informational. Trusted Actions, exact checks, and durable Development state remain authoritative.",
  ].join("\n");
}
