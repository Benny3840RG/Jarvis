# AM-016 `security:tcp-check` — planning evidence (Phases 1–5)

**Status:** planning only. This records implementation and verification evidence for
the I/O-free core of the Stage 3 `security:tcp-check` capability. It does **not**
commission, deploy, authorise diagnostics, or populate any allowlist. AM-016 stays
`lifecycle_status: planned` pending the concrete kernel/proxy egress enforcer and a
separate, owner-approved commissioning tranche (see
`docs/design/issue-732-stage3-authorised-diagnostics.md` §Gates and issue #779).

## Scope of the evidence

Pull request **#780** (branch `feat/issue-732-tcp-check-core`), implementing the
plan tracked in #779. The policy core is pure and the TCP-check modules import no
`node:net`. The socket is an injected port with a fail-closed default, and the governed provider is
deliberately **not** registered into the live tool-execution service, so
`externalProviderFor` never resolves it.

| Phase | Deliverable | Source | Tests |
|---|---|---|---|
| 1 | Policy core (canonical parse, special-use table + trusted anchor, allowlist, digest, freshness) | `typescript/src/security/tcpCheck/{address,specialUseTable,specialUseTableAnchor,allowlist,allowlistDigest,freshness}.ts` | `TEST-AM-016-CORE-001` |
| 2 | Admission state machine (single owner slot, never-refunded rate window, fenced transitions, recovery by durable phase, signal-only resolve) | `typescript/src/security/tcpCheck/admission.ts` | `TEST-AM-016-ADMISSION-001` |
| 3 | Supervised egress mediator + single-use ledger (Decision-0 broker behind `EgressEnforcer`) | `typescript/src/security/tcpCheck/{egressClaim,singleUseLedger,enforcer}.ts` | `TEST-AM-016-MEDIATOR-001` |
| 4 | Governed wiring (T3 tool definition, `exact_action_fingerprint`, digest-only results, egress provider, claim-binding port and in-memory reference) | `typescript/src/security/tcpCheck/{tcpCheckTool,tcpCheckProvider}.ts` | `TEST-AM-016-WIRING-001` |
| 5 | Adversarial acceptance suite + review-hardening regressions | `typescript/tests/tcpCheck{Acceptance,ProviderResidual}.test.ts` | `TEST-AM-016-CORE-001`..`WIRING-001` |

## Verification

- The [repair handoff](https://github.com/Benny3840RG/Jarvis/pull/780#issuecomment-6728735371)
  records 110 passing TCP tests and passing static checks on `6ea3477ba0ac8d47a99426dfced98ffcbb91f1b5`.
  The full local run was interrupted after Unix-socket proxy failures.
- The [registry validation](https://github.com/Benny3840RG/Jarvis/actions/runs/42536830047/job/128902869622)
  applies to `119d532864df8498e8b179e02f5d6f74eb432dd6`. Check the current PR head's
  checks separately; neither this record nor an earlier pass clears a later revision.
- [Independent review findings](https://github.com/Benny3840RG/Jarvis/pull/780#issuecomment-6728816313)
  and targeted repairs are recorded on #780. Full independent review remains open.
  The in-memory binding store exercises replay logic; it does not prove durable
  restart recovery. Special-use snapshot source provenance also remains unverified.
- No `node:net` import in any module; a test asserts
  `createTcpCheckProviderFromEnv()` returns `null` (capability stays planned).

## Explicitly out of scope

Real socket connector, kernel/proxy egress gate, populated allowlist, commissioning,
deployment, and any production diagnostics authority. These require separate owner
approval per the design's Gates and #779.
