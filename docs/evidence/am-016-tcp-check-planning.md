# AM-016 `security:tcp-check` — planning evidence (Phases 1–5 + independent review)

**Status:** planning only. This records implementation and verification evidence for
the I/O-free core of the Stage 3 `security:tcp-check` capability. It does **not**
commission, deploy, authorise diagnostics, or populate any allowlist. AM-016 stays
`lifecycle_status: planned` pending the concrete kernel/proxy egress enforcer and a
separate, owner-approved commissioning tranche (see
`docs/design/issue-732-stage3-authorised-diagnostics.md` §Gates and issue #779).

## Scope of the evidence

Pull request **#780** (branch `feat/issue-732-tcp-check-core`), implementing the
plan tracked in #779. Every module is I/O-free and imports no `node:net`; the
socket is an injected port with a fail-closed default, and the governed provider is
deliberately **not** registered into the live tool-execution service, so
`externalProviderFor` never resolves it.

| Phase | Deliverable | Source | Tests |
|---|---|---|---|
| 1 | Policy core (canonical parse, special-use table + trusted anchor, allowlist, digest, freshness) | `typescript/src/security/tcpCheck/{address,specialUseTable,specialUseTableAnchor,allowlist,allowlistDigest,freshness}.ts` | `TEST-AM-016-CORE-001` |
| 2 | Admission state machine (single owner slot, never-refunded rate window, fenced transitions, recovery by durable phase, signal-only resolve) | `typescript/src/security/tcpCheck/admission.ts` | `TEST-AM-016-ADMISSION-001` |
| 3 | Supervised egress mediator + single-use ledger (Decision-0 broker behind `EgressEnforcer`) | `typescript/src/security/tcpCheck/{egressClaim,singleUseLedger,enforcer}.ts` | `TEST-AM-016-MEDIATOR-001` |
| 4 | Governed wiring (T3 tool definition, `exact_action_fingerprint`, digest-only results, egress provider, durable claim-binding store) | `typescript/src/security/tcpCheck/{tcpCheckTool,tcpCheckProvider}.ts` | `TEST-AM-016-WIRING-001` |
| 5 | Adversarial acceptance suite + review-hardening regressions | `typescript/tests/tcpCheck{Acceptance,ProviderResidual}.test.ts` | `TEST-AM-016-CORE-001`..`WIRING-001` |

## Verification

- **110 `node:test` cases** across `tcpCheck{Core,Admission,Enforcer,GovernedWiring,Acceptance,ProviderResidual}.test.ts`; repo `type-check`, `lint`, and `format:check` pass.
- Required CI on #780 green through every phase and every repair round
  (`typecheck-lint-format-test`, `pr-evidence`, `automation-policy`,
  `jarvis-console-01-build`, `CodeQL`).
- Independent review (~6 rounds) completed with every code finding addressed:
  canonical-parse / special-use anchor, admission atomicity and attempt/fence-scoped
  cleanup, ledger-first duplicate handling, approved-digest and freshness-source
  binding, claim immutability + durable reservation binding with completed-replay
  tombstones, and the uncertain-phase lifecycle.
- No `node:net` import in any module; a test asserts
  `createTcpCheckProviderFromEnv()` returns `null` (capability stays planned).

## Explicitly out of scope

Real socket connector, kernel/proxy egress gate, populated allowlist, commissioning,
deployment, and any production diagnostics authority. These require separate owner
approval per the design's Gates and #779.
