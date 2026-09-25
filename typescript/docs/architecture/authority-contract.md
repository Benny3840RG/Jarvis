# Authority contract

Status: PR A of the authority-first acquisition plan (`docs/ROADMAP.md`).
Source: `src/governance/authorityContract.ts`. Tests: `tests/authorityContract.test.ts`.

## Rule

Every acquired component sits under Jarvis authority. No acquired component
becomes Jarvis authority.

This file does not add or change constitutional law. The laws are in
`JARVIS_CONSTITUTION.md`, and changing them needs operator authority
(JARVIS-010). This contract maps system layers and testable invariants onto
those laws.

## Layer ownership

| Layer           | Owns                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| Development     | mission state, candidate SHA, approval cycle, plans, evidence requirements |
| ΩΣ              | permission to cause side effects                                           |
| Temporal        | durable execution, retries, recovery, sequencing                           |
| ACP             | communication with coding agents                                           |
| MCP             | capability transport                                                       |
| External agents | proposed work only                                                         |
| Benny           | merge, production deployment, authority-policy changes                     |

Each responsibility has exactly one owner. That is tested.

For merge, "owns" means Benny makes the decision. Today the governed
`github:merge-pull-request` tool action can be approved only with
`JARVIS_APPROVAL_TOKEN`. That is a human-only credential, separate from the
service token that agents hold. After approval, Jarvis executes the action
through `ToolExecutionService`, which re-checks the reviewed head SHA and
candidate evidence.

## Invariants

A build fails if an `enforced` invariant loses its evidence test, or if a
`planned` invariant is not listed in the roadmap.

| ID          | Forbids                                                                     | Status                 |
| ----------- | --------------------------------------------------------------------------- | ---------------------- |
| AUTH-INV-01 | an agent can authorise a merge (executing an owner-approved one is allowed) | enforced               |
| AUTH-INV-02 | an agent can deploy                                                         | enforced (by absence)  |
| AUTH-INV-03 | MCP can bypass ΩΣ                                                           | enforced (current MCP) |
| AUTH-INV-04 | a Temporal Workflow can invent authority                                    | enforced (static scan) |
| AUTH-INV-05 | an ACP permission response is authoritative by itself                       | planned, PR G          |
| AUTH-INV-06 | approval valid against the wrong candidateSha                               | enforced               |
| AUTH-INV-07 | approval reused across approvalCycle                                        | enforced               |
| AUTH-INV-08 | replay causes a second external effect                                      | enforced               |
| AUTH-INV-09 | a stale candidate overwrites a newer one                                    | enforced               |
| AUTH-INV-10 | an unadvertised MCP tool executes                                           | enforced               |
| AUTH-INV-11 | deployment credentials enter an agent sandbox                               | planned, PR M          |

## Limits of this evidence

- **AUTH-INV-02 is enforced by absence.** No operator API operation or MCP tool
  deploys anything. The test fails if one appears. It does not prove that a
  process holding host credentials cannot deploy outside Jarvis.
- **AUTH-INV-03 covers the current MCP adapter only.** The MCP adapter reaches
  only OpenAPI operations and none of the approve, execute or revoke
  operations. The per-session capability guard is PR E.
- **AUTH-INV-04 is a static scan of `src/preview/temporalPass/`.** It checks
  that the preview does not reference the approval token, call `.approve(`, or
  import the HTTP layer. A production Temporal layout (PR B) must be added to
  the same scan.
- **Most AUTH-INV-06 to AUTH-INV-09 evidence is `suite: "temporal-pass"`.**
  Those tests run under `npm run test:temporal-pass` and in
  `.github/workflows/temporal-pass.yml`. That job runs only when a pull request
  changes `src/preview/temporalPass/**`, `tests/pass/**` or the npm manifests.
  They are not part of `npm run check`. This PR checks only that those tests
  still exist under the cited titles. PR B should decide whether the job runs
  on every pull request.
- **Service-token holders can still propose and execute.** An agent with the
  service token can create a tool action. It can also execute an action that
  the owner has already approved. It cannot approve one. That is the intended
  split, and it depends on `JARVIS_APPROVAL_TOKEN` never reaching an agent.
  Nothing in the repository can test where that token is stored.

## Adding an invariant

1. Add it to `AUTHORITY_INVARIANTS` with at least one constitutional law.
2. If a test enforces it, cite that test's exact `it(...)` title and file.
   Otherwise mark it `planned`, name the roadmap PR, and add the ID to that
   PR's row in `docs/ROADMAP.md`.
3. Run `npm run check`.
