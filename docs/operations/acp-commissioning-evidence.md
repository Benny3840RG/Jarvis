# ACP governed consultation — commissioning evidence

This is the evidence bundle for the ACP governed-consultation commissioning slice.
It separates what was actually done and verified (code) from what requires the
J-arvis host and an owner decision (host + live). Nothing here is asserted YES
because "the configuration looks correct" — only because it was run.

## Code evidence

- **Base SHA:** `c874fe61359db510f993c8f9d6f3964f11064572` (origin/main at start).
  Note: the handover referenced `87139d54…`, which predates current main; this
  work is based on the actual current `origin/main`.
- **Branch:** `claude/jarvis-architecture-roadmap-gf81hq`.
- **Worktree:** the session's own isolated checkout (`/home/user/Jarvis`), clean
  at start. The handover's concurrent-work concern is a different host path
  (`/home/benny3840/Jarvis`, `experiment/temporal-pass`) not present here.
- **Changed / added files:**
  - `typescript/src/acp/acpOperatingMode.ts` (new) — pure mode policy + failure taxonomy.
  - `typescript/src/acp/acpGovernedConsultation.ts` (new) — classifying, mode-aware consultation.
  - `typescript/src/acp/nolanAcpWorker.ts` (new) — worker reviewer adapter core.
  - `typescript/src/acp/acpStdioTransport.ts` (edit) — added typed failure `code` to `AcpStdioTransportError` (additive; no semantics changed).
  - `typescript/src/actions/governedExternalOperation.ts` (edit) — wired consultation into `execute()`; added `AcpConsultationBlockedError`; dormant-first factory wiring.
  - Tests: `tests/acpOperatingMode.test.ts`, `tests/acpGovernedConsultation.test.ts`, `tests/nolanAcpWorker.test.ts`, `tests/fixtures/acpWorkerFixture.ts`, and an ACP-wiring block in `tests/governedExternalOperation.test.ts`.
  - Docs: `typescript/docs/architecture/acp-governed-consultation.md`, this file, ROADMAP entry.
- **Authority integration design:** `governedApprovalPresent` is the ToolAction's
  server-computed approval state (non-consuming), NOT the caller's `ToolAuthority`.
  The atomic claim/eligibility gate in `ToolExecutionService` still re-validates
  immediately before the effect. See the architecture note.
- **ACP mode implementation:** `disabled` / `advisory` / `required` in
  `acpOperatingMode.ts`; the strict `consultAcpPeer` primitive is unchanged.
- **Test command results:** `npm run check` → tsc + ESLint + Prettier + OpenAPI
  clean; node test suite **2055 pass, 0 fail, 1 skipped** (2056 total),
  ~75s. The three-mode matrices, the "no governed authority + allow ⇒ block",
  the "required block never invokes the provider and never consumes the
  single-use claim", the "required block on a reusable action never calls
  eligibility.verify", and a real spawned-subprocess stdio path (allow / deny /
  silent-timeout) are all covered.

### Gate A — implementation

| Item | State |
| ---- | ----- |
| Isolated worktree | Session checkout, clean at start |
| Authority signal resolved (non-consuming, not ToolAuthority) | DONE |
| Mode policy implemented (disabled/advisory/required) | DONE |
| ACP wired into the governed boundary (one choke point) | DONE |
| Tests green | DONE (2055 pass) |
| No live model worker | Confirmed — none launched |

### Gate B — deterministic fake worker

Exercised **in-process** (fake `AcpChildProcess`) and as a **real spawned
subprocess** (`tests/fixtures/acpWorkerFixture.ts` via `spawnAcpChild`): allow,
deny, abstain, crash/close, mismatched id, flood bound, timeout, and mode-specific
behaviour. The subprocess uses the real `runAcpWorker` core with a static
decider — no network, no credential.

## Host evidence

**NONE PRODUCED FROM THIS ENVIRONMENT.** This session is a cloud sandbox
(`/home/user/Jarvis`), not the J-arvis host. It cannot apply systemd sandboxing,
run hostile egress probes, provision a real model credential, or launch a live
worker. The runbook (`docs/operations/acp-worker-sandbox.md`) documents the
required host controls; they remain **UNVERIFIED** here.

## Live-state evidence

```
ACP worker configured:            NO   (JARVIS_ACP_WORKER_COMMAND unset)
Sandbox verified:                 NO   (host-only; not doable in this sandbox)
Real model credential installed:  NO
Dry-run consultation verified:    NO   (no worker; no credential)
Required-mode canary configured:  NO   (JARVIS_ACP_MODE unset ⇒ disabled)
Live canary enabled:              NO
PR merged:                        NO   (draft; owner-only)
Production deployment performed:  NO
```

## UNVERIFIED / BLOCKED

- **Worker protocol vs. installed CLIs.** It is NOT verified that the installed
  `claude` / `codex` CLIs speak Nolan's ACP stdio envelope. They almost certainly
  do not (it is a Jarvis-internal framing). The `nolan-acp-worker` core here is the
  minimal adapter shell; a **live model-backed decider is intentionally not
  implemented** — it needs the worker's own credential + governed egress (Gate D).
- **Gate C (sandbox) / hostile-probe verification** — requires the host.
- **Gate D (real worker, dry-run)** — requires credential + egress + host.
- **Gate E/F (live canary, expansion)** — owner-gated; not attempted.

## Operator handover (plain language)

1. **What changed?** ACP consultation is now wired into the one external-effect
   choke point (`GovernedExternalOperation.execute`), with three explicit modes.
   It is off by default.
2. **What can Nolan now do that it couldn't?** Nothing yet, at runtime — the path
   is dormant. Once an owner enables it, Nolan can consult a peer reviewer for
   evidence (advisory) or as an extra veto/availability gate (required).
3. **What can the ACP worker definitely not do?** Two different kinds of limit —
   do not conflate them:
   - **By protocol/authority (structural in code, holds now):** its only output
     is one advisory `allow`/`deny`/`abstain`, so it cannot approve a ToolAction,
     merge, deploy, change authority/policy, or manufacture ACP authority — the
     governed gate treats its `allow` as non-authoritative regardless. This is
     enforced by the consultation code and the AUTH-INV-05 primitive, independent
     of the host.
   - **By process isolation (host sandbox, currently UNVERIFIED):** reading the
     repo/credentials, running arbitrary shell, reaching the network, or causing
     any external effect are prevented **only** by the host sandbox
     (filesystem/network/privilege confinement). The code allowlists just the
     child's *environment*; it does not, and from Node cannot, confine the worker
     process. Until Gate C is verified on the host, treat these as **not**
     guaranteed — do not enable a mode above `disabled` on the strength of the
     code alone.
4. **What was verified on the J-arvis host?** Nothing — see Host evidence.
5. **Is ACP disabled, advisory, or required?** Disabled (default).
6. **Has a real model consultation succeeded?** No.
7. **Has any live external operation passed through ACP?** No.
8. **What remains disabled?** All live behaviour — worker launch, real
   consultation, canary.
9. **What decision does Benny need next?** Whether to commission on the host
   (apply the sandbox, provision a worker credential, set `JARVIS_ACP_WORKER_*`,
   run Gate C/D), and only after reviewing that evidence, whether to enable a
   narrow `advisory` canary. This PR does not ask to enable anything.
10. **Rollback.** Unset `JARVIS_ACP_MODE` (or set it to `disabled`) and/or unset
    `JARVIS_ACP_WORKER_COMMAND`. No DB change, no receipt deletion, no ΩΣ/ToolAction
    change. Config-level and immediate.

## Environment variables (all optional; dormant when unset)

- `JARVIS_ACP_MODE` = `disabled` (default) | `advisory` | `required`.
- `JARVIS_ACP_WORKER_COMMAND` / `JARVIS_ACP_WORKER_ARGS` — worker launch config
  (see `acpWorkerConfig.ts`). Point `_COMMAND` at the sandbox launcher
  (`systemd-run …`) per the sandbox runbook, not directly at the model CLI.
