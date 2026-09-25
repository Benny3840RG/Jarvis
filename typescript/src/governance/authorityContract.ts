/**
 * Jarvis authority contract: who owns what, and which invariants keep it that way.
 *
 * This is a declaration, not an enforcement point. It grants no authority and is
 * consulted by nothing at runtime. `tests/authorityContract.test.ts` holds it to
 * the codebase in two ways:
 *
 *   1. every `enforced` invariant names the test that proves it, and that test
 *      must still exist under that exact title (no silent drift); and
 *   2. every `planned` invariant names the roadmap PR that must deliver it, so an
 *      unenforced rule is visible rather than assumed.
 *
 * The canonical laws stay in `JARVIS_CONSTITUTION.md` (changing them is Risk 3 and
 * operator-only per JARVIS-010). This file only maps layers and invariants onto
 * those laws. See `docs/architecture/authority-contract.md`.
 */

export type AuthorityLayer =
  "development" | "omega" | "temporal" | "acp" | "mcp" | "external-agents" | "benny";

export type AuthorityResponsibility =
  | "mission-state"
  | "candidate-sha"
  | "approval-cycle"
  | "plans"
  | "evidence-requirements"
  | "side-effect-permission"
  | "durable-execution"
  | "retries"
  | "recovery"
  | "sequencing"
  | "agent-communication"
  | "capability-transport"
  | "proposed-work"
  | "merge"
  | "production-deployment"
  | "authority-policy-change";

export const LAYER_OWNERSHIP: Readonly<Record<AuthorityLayer, readonly AuthorityResponsibility[]>> =
  {
    development: [
      "mission-state",
      "candidate-sha",
      "approval-cycle",
      "plans",
      "evidence-requirements",
    ],
    omega: ["side-effect-permission"],
    temporal: ["durable-execution", "retries", "recovery", "sequencing"],
    acp: ["agent-communication"],
    mcp: ["capability-transport"],
    "external-agents": ["proposed-work"],
    benny: ["merge", "production-deployment", "authority-policy-change"],
  };

/** Responsibilities that no automated layer may hold, directly or by delegation. */
export const OWNER_ONLY_RESPONSIBILITIES: readonly AuthorityResponsibility[] = [
  "merge",
  "production-deployment",
  "authority-policy-change",
];

/**
 * `suite: "check"` runs under `npm run check`. `suite: "temporal-pass"` runs under
 * `npm run test:temporal-pass` and the path-filtered `.github/workflows/temporal-pass.yml`
 * job only; it is not part of `npm run check`.
 */
export type InvariantEvidence = Readonly<{
  suite: "check" | "temporal-pass";
  /** Path relative to `typescript/`. */
  file: string;
  /** Exact `it(...)` title inside that file. */
  test: string;
}>;

/** Independent PRs from `typescript/docs/ROADMAP.md` ("Authority-first acquisition plan"). */
export type RoadmapPr = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M";

export type AuthorityInvariant = Readonly<{
  id: string;
  /** The failure this invariant forbids. */
  forbids: string;
  /** `JARVIS_CONSTITUTION.md` laws this invariant serves. */
  laws: readonly string[];
}> &
  (
    | Readonly<{ status: "enforced"; evidence: readonly InvariantEvidence[] }>
    | Readonly<{ status: "planned"; deliveredBy: RoadmapPr; reason: string }>
  );

export const AUTHORITY_INVARIANTS: readonly AuthorityInvariant[] = [
  {
    id: "AUTH-INV-01",
    forbids: "An agent can merge a pull request.",
    laws: ["JARVIS-002", "JARVIS-007", "JARVIS-013"],
    status: "enforced",
    evidence: [
      {
        suite: "check",
        file: "tests/toolActionHttp.test.ts",
        test: "rejects approval without a valid approval token before calling the service",
      },
      {
        suite: "check",
        file: "tests/authorityContract.test.ts",
        test: "exposes no approve, execute, revoke, merge or deploy operation through MCP",
      },
      {
        suite: "check",
        file: "tests/authorityContract.test.ts",
        test: "requires an exact reviewed head SHA and owner-level risk for the governed merge",
      },
    ],
  },
  {
    id: "AUTH-INV-02",
    forbids: "An agent can deploy to production.",
    laws: ["JARVIS-003", "JARVIS-007"],
    status: "enforced",
    evidence: [
      {
        suite: "check",
        file: "tests/authorityContract.test.ts",
        test: "offers no deployment operation in the operator API or MCP surface",
      },
    ],
  },
  {
    id: "AUTH-INV-03",
    forbids: "MCP can bypass ΩΣ.",
    laws: ["JARVIS-003", "JARVIS-018"],
    status: "enforced",
    evidence: [
      {
        suite: "check",
        file: "tests/mcpOperationContract.test.ts",
        test: "keeps every MCP-exposed operation within the OpenAPI contract",
      },
      {
        suite: "check",
        file: "tests/authorityContract.test.ts",
        test: "exposes no approve, execute, revoke, merge or deploy operation through MCP",
      },
    ],
  },
  {
    id: "AUTH-INV-04",
    forbids: "A Temporal Workflow can invent authority.",
    laws: ["JARVIS-003", "JARVIS-007", "JARVIS-018"],
    status: "enforced",
    evidence: [
      {
        suite: "check",
        file: "tests/authorityContract.test.ts",
        test: "keeps the Temporal PASS preview away from approval credentials and approve calls",
      },
    ],
  },
  {
    id: "AUTH-INV-05",
    forbids: "An ACP permission response becomes authoritative by itself.",
    laws: ["JARVIS-002", "JARVIS-013"],
    status: "planned",
    deliveredBy: "G",
    reason: "No ACP transport exists yet.",
  },
  {
    id: "AUTH-INV-06",
    forbids: "An approval is valid against the wrong candidateSha.",
    laws: ["JARVIS-011", "JARVIS-017"],
    status: "enforced",
    evidence: [
      {
        suite: "temporal-pass",
        file: "tests/pass/sha-race.test.ts",
        test: "fails closed when HEAD moves after approval but before merge",
      },
      {
        suite: "check",
        file: "tests/githubDevelopmentMission.test.ts",
        test: "rejects a moved head before durable intent, so gate rejection does not exercise approval",
      },
    ],
  },
  {
    id: "AUTH-INV-07",
    forbids: "An approval is reused across approvalCycle.",
    laws: ["JARVIS-011", "JARVIS-016"],
    status: "enforced",
    evidence: [
      {
        suite: "temporal-pass",
        file: "tests/pass/duplicate-signal.test.ts",
        test: "a stale signal for a superseded approval cycle is ignored, not applied",
      },
    ],
  },
  {
    id: "AUTH-INV-08",
    forbids: "Replay causes a second external effect.",
    laws: ["JARVIS-005", "JARVIS-016"],
    status: "enforced",
    evidence: [
      {
        suite: "temporal-pass",
        file: "tests/pass/side-effect.test.ts",
        test: "re-executing mergePR for an already-merged step is a no-op, not a duplicate merge",
      },
      {
        suite: "temporal-pass",
        file: "tests/pass/merge-crash-recovery.test.ts",
        test: "reconciles the already-merged state instead of duplicating or failing the retry",
      },
      {
        suite: "temporal-pass",
        file: "tests/pass/quote-send-crash-recovery.test.ts",
        test: "retries once against the open reconciliation and does not send again",
      },
      {
        suite: "check",
        file: "tests/githubDevelopmentMission.test.ts",
        test: "blocks a concurrent resume loser before another provider call",
      },
    ],
  },
  {
    id: "AUTH-INV-09",
    forbids: "A stale candidate overwrites a newer candidate.",
    laws: ["JARVIS-011", "JARVIS-017"],
    status: "enforced",
    evidence: [
      {
        suite: "temporal-pass",
        file: "tests/pass/latest-candidate.test.ts",
        test: "merges the reworked build, not the original one that needed changes",
      },
      {
        suite: "check",
        file: "tests/githubDevelopmentMission.test.ts",
        test: "does not reconcile an independently merged different candidate as the approved merge",
      },
    ],
  },
  {
    id: "AUTH-INV-10",
    forbids: "An unadvertised MCP tool executes.",
    laws: ["JARVIS-003", "JARVIS-017"],
    status: "enforced",
    evidence: [
      {
        suite: "check",
        file: "tests/authorityContract.test.ts",
        test: "refuses an unadvertised MCP tool without calling the operator API",
      },
    ],
  },
  {
    id: "AUTH-INV-11",
    forbids: "Deployment credentials enter an agent sandbox.",
    laws: ["JARVIS-007"],
    status: "planned",
    deliveredBy: "M",
    reason: "No sandbox executor exists yet.",
  },
];
