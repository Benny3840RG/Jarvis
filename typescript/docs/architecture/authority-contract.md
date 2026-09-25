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

Each invariant has one of three statuses:

- `enforced`: tests exercise the real enforcement point and fail if it stops
  refusing.
- `guarded`: a static or name-based tripwire exists, but it cannot prove the
  invariant. A determined bypass, such as aliasing or neutral naming, can pass
  it. The invariant names the roadmap PR that must replace the tripwire with
  real enforcement.
- `planned`: nothing checks it yet. It names the roadmap PR that will.

A build fails if an `enforced` or `guarded` invariant loses its evidence test.
It also fails if a `guarded` or `planned` invariant is missing from its PR's
row in the roadmap. An evidence test counts only
if the parsed syntax tree of the cited file contains an `it(...)` or `test(...)`
call with that exact title. A matching comment or string does not count, and
neither does a skipped test.

| ID          | Forbids                                                                     | Status        |
| ----------- | --------------------------------------------------------------------------- | ------------- |
| AUTH-INV-01 | an agent can authorise a merge (executing an owner-approved one is allowed) | enforced      |
| AUTH-INV-02 | an agent can deploy                                                         | guarded, PR M |
| AUTH-INV-03 | MCP can bypass ΩΣ                                                           | guarded, PR E |
| AUTH-INV-04 | a Temporal Workflow can invent authority                                    | guarded, PR B |
| AUTH-INV-05 | an ACP permission response is authoritative by itself                       | planned, PR G |
| AUTH-INV-06 | approval valid against the wrong candidateSha                               | enforced      |
| AUTH-INV-07 | approval reused across approvalCycle                                        | enforced      |
| AUTH-INV-08 | replay causes a second external effect                                      | enforced      |
| AUTH-INV-09 | a stale candidate overwrites a newer one                                    | enforced      |
| AUTH-INV-10 | an unadvertised MCP tool executes                                           | enforced      |
| AUTH-INV-11 | deployment credentials enter an agent sandbox                               | planned, PR M |

## Limits of this evidence

- **AUTH-INV-02 is guarded by an absence check on names.** The test fails if
  deploy, release, promote or rollout appears in any of these: an operator API
  path, operationId, summary or tag; an MCP-reached operation; or an MCP tool
  name. It reads declared names, not what a handler does. So an operation that
  deploys under a neutral name would pass, and review of each new operation is
  still needed. It also does not prove that a process holding host credentials
  cannot deploy outside Jarvis.
- **AUTH-INV-03 is guarded for the current MCP adapter only.** The MCP adapter reaches
  only OpenAPI operations and none of the approve, execute or revoke
  operations. The per-session capability guard is PR E.
- **AUTH-INV-04 is guarded by a static scan of `src/preview/temporalPass/`.** It follows
  every import from the preview, direct or transitive, as parsed from the
  syntax tree. That includes static and side-effect imports, re-exports,
  `import x = require()`, `require()`, `import()` and import types. The test
  fails on any import it cannot resolve: a template with substitutions, a
  concatenated or variable path, any reference to `createRequire`, `require`
  used as a value rather than called directly, an absolute path, a `#`
  subpath import, or a self-reference to the `jarvis-typescript` package. It
  treats bare specifiers as packages. That holds only while the repository
  defines no import aliases, so the test also fails if `package.json` gains
  `imports`, or either tsconfig has `paths` or `baseUrl`, including options inherited through `extends`. The scan fails if a
  module the preview reaches:
  - is under `src/http/`;
  - references `approve` and is not one of the two approval-boundary modules
    named below. A reference is a property access, `x["approve"]`, a bare
    `approve()` call, or an imported `approve` binding;
  - is a preview module that references the approval token;
  - references the approval token and is not one of the two reviewed modules
    that already handle it, `src/actions/toolActions.ts` and
    `src/persistence/convexToolActions.ts`.

  The preview reaches those two modules only to propose and execute. This is a
  syntax scan, not a call graph. A computed property key or other runtime
  indirection can still pass it, which is why the invariant is `guarded`. PR B
  must enforce it at runtime: the production worker gets no approval
  credential, and activities reach effects only through the governed boundary.

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
   If only a static or name-based tripwire exists, mark it `guarded`. If
   nothing checks it, mark it `planned`. For either status, name the roadmap PR
   that will enforce it, and add the ID to that PR's row in `docs/ROADMAP.md`.
3. Run `npm run check`.
