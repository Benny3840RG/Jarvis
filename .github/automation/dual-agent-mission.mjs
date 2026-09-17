const SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const EXECUTORS = new Set(["codex", "claude"]);

function exactIdentity(value) {
  if (
    !Number.isSafeInteger(value?.pullNumber) ||
    value.pullNumber < 1 ||
    !SHA.test(value.headSha) ||
    !SHA.test(value.baseSha) ||
    !FINGERPRINT.test(value.fingerprint)
  ) {
    throw new Error("Invalid exact candidate identity.");
  }
  return {
    pullNumber: value.pullNumber,
    headSha: value.headSha,
    baseSha: value.baseSha,
    fingerprint: value.fingerprint,
  };
}

function rolePlan(previousTerminalBuilder, availableExecutors) {
  const available = new Set(availableExecutors || ["codex"]);
  if (![...available].every((executor) => EXECUTORS.has(executor)))
    throw new Error("Unknown agent executor.");
  const preferred = previousTerminalBuilder === "codex" ? "claude" : "codex";
  if (!available.has(preferred)) {
    return {
      builder: preferred,
      reviewer: preferred === "codex" ? "claude" : "codex-independent",
      phase: "blocked",
      reason: `${preferred === "claude" ? "Claude" : "Codex"} builder executor is unavailable.`,
    };
  }
  return {
    builder: preferred,
    reviewer: preferred === "codex" ? "codex-independent" : "codex-independent",
    phase: "claimed",
  };
}

export function claimMission({
  issueNumber,
  baseSha,
  previousTerminalBuilder,
  availableExecutors,
} = {}) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new Error("Invalid issue number.");
  if (!SHA.test(baseSha)) throw new Error("Invalid base SHA.");
  if (previousTerminalBuilder !== undefined && !EXECUTORS.has(previousTerminalBuilder))
    throw new Error("Invalid previous terminal builder.");
  const roles = rolePlan(previousTerminalBuilder, availableExecutors);
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
  claimed: new Set(["candidate", "blocked"]),
  "waiting-ci": new Set(["review-started", "blocked"]),
  reviewing: new Set(["repair-required", "awaiting-owner", "blocked"]),
  "repair-required": new Set(["candidate", "blocked"]),
  "awaiting-owner": new Set(["terminal"]),
  blocked: new Set(["terminal"]),
};

export function advanceMission(mission, event = {}) {
  if (!mission || typeof mission !== "object" || !transitions[mission.phase])
    throw new Error("Invalid mission phase.");
  if (!transitions[mission.phase].has(event.type))
    throw new Error(`Mission phase ${mission.phase} cannot consume ${event.type}.`);
  if (event.type === "blocked")
    return { ...mission, phase: "blocked", reason: String(event.reason || "Blocked.") };
  if (event.type === "terminal") return { ...mission, phase: "terminal" };
  if (event.type === "candidate") {
    const identity = exactIdentity(event);
    if (identity.baseSha !== mission.baseSha)
      throw new Error("Candidate base SHA differs from the claimed mission base.");
    return { ...mission, phase: "waiting-ci", identity };
  }
  const identity = requireCurrentIdentity(mission, event);
  if (event.type === "repair-required") {
    if (event.builder !== mission.builder)
      throw new Error("Repairs must return to the original builder.");
    return { ...mission, phase: "repair-required", identity, repairCount: mission.repairCount + 1 };
  }
  if (event.type === "review-started") return { ...mission, phase: "reviewing", identity };
  if (event.type === "awaiting-owner")
    return { ...mission, phase: "awaiting-owner", identity };
  throw new Error("Unsupported mission event.");
}

export function renderMissionReceipt(mission) {
  if (!mission || typeof mission !== "object") throw new Error("Invalid mission.");
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
    `Repairs routed to original builder: ${mission.builder} (${mission.repairCount || 0})`,
    "Owner interrupts: merge approval, deployment approval, or blocked ambiguity/risk.",
    "Merge authorised: NO",
    "Deployment authorised: NO",
    "This receipt is informational. Trusted Actions, exact checks, and durable Development state remain authoritative.",
  ].join("\n");
}
