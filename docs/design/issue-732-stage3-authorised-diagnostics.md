# #732 Stage 3 — authorised diagnostics: design & threat model (planning only)

**Status: proposal for owner review. No code, no production configuration, and no
action-family lifecycle change is made by this document.** It is the Stage 1
"discovery and design" deliverable for the _next_ stage, written now that Stage 2
has landed. Building any Stage 3 code requires explicit owner approval and a
separate, dedicated PR (per #732's own gating).

## Where #732 stands

- **Stage 2 (education-only MVP): merged** via PR #747 (`b7ee7623`, 2026-10-25).
  `security:explain` and `security:interpret` exist as governed, T1, offline,
  side-effect-free tools (`typescript/src/actions/securityEducation.ts`), with a
  fixed concept catalogue, a narrow port-state parser, pre-storage minimisation,
  digest-bound transient results, registries AM-014/AM-015 (`planned`), OpenAPI,
  operator + evidence docs, and tests. No network, shell, filesystem, or model
  access is reachable from those handlers.
- **Stages 3–5: not started, owner-gated.** The issue requires _"separate designs
  and approvals"_ for diagnostics and labs, and a further owner approval for
  advanced testing. This document covers **Stage 3 only** and proposes the
  smallest safe diagnostics slice.

## Stage 3 objective (from #732)

> Reviewed, parameterised adapters for safe inventory and network diagnostics;
> explicit target allowlist (CIDR/IP/domain), bounded timeout/rate/concurrency,
> no arbitrary shell strings, immutable receipts and redaction.

The design goal is a capability that answers "is this _authorised_ target
reachable / what does its certificate say / how does this name resolve" through
**reviewed code paths with no free-form execution**, reusing every existing
governance primitive rather than adding a new effect channel.

## Smallest safe first slice (proposed)

Three read-only, bounded diagnostics, each a reviewed parameterised adapter — **no
raw sockets, no SYN scan, no shell, no user-supplied command or argument string**:

1. `security:tcp-check` — a single TCP _connect_ to one allowlisted `host:port`,
   reporting connect / refused / timed-out. Not a port scanner: one target, one
   port, one attempt per action.
2. `security:dns-lookup` — resolve one allowlisted name for a fixed record-type
   set (A/AAAA/CNAME/MX/TXT), reporting the records as data.
3. `security:tls-inspect` — open a TLS connection to one allowlisted `host:port`
   and report certificate subject/issuer/validity and negotiated protocol/cipher.
   Inspection only; no verification bypass, no client cert, no data sent.

Anything broader (ranges, multi-port sweeps, UDP probing, scripts) is explicitly
**out of this slice** and would need its own design and approval.

## Architecture — reuse, do not reinvent

Stage 3 is a new **external-effect** capability, so unlike Stage 2 it must run
through the full governed boundary:

- **Authority:** `minimumAuthority: "T3"` (the top tier, `src/runtime/totalityPolicy.ts`)
  — matching the destructive/external class, versus education's T1.
- **Governed effect boundary:** execute via `GovernedExternalOperation`
  (`src/actions/governedExternalOperation.ts`) and the ToolAction
  claim → receipt → reconciliation boundary
  (`omega-tool-action-claim-receipt:v1`). A PolicyEngine allowlist is **not**
  authority (`assertNotPolicyEngineAuthority`); the adapter must obtain the
  single-use claim like any other external effect.
- **External provider:** declare `externalProvider` on each
  `ToolExecutionDefinition` and register it via `externalProviderFor(tool, operation)`,
  so the diagnostics adapter is the only code that can emit these effects.
- **Staging/approval/receipts:** reuse the existing stage → approve (human,
  `exact_action_fingerprint`) → single-use consumption → immutable
  `toolExecutionReceipts` path. Receipts stay **digest-only and redacted**; no
  pasted or resolved value is echoed into a receipt, log, or answer beyond a
  bounded, secret-redacted summary.
- **Bounds:** per-action timeout capped at the existing `MAX_TIMEOUT_MS` (30 s),
  plus a diagnostics-specific **rate and concurrency ceiling** (e.g. 1 in-flight
  diagnostic per owner, N per rolling window) enforced before the claim.
- **Config:** the **target allowlist** (CIDR/IP/domain) is reviewed configuration,
  default-deny and empty until the owner populates it; it is not a model- or
  prompt-supplied value and cannot be widened at call time.

## Threat model

**Trust boundaries.** Caller input (target, port, record type) is untrusted and
validated against the reviewed allowlist and strict schemas. The allowlist,
adapters, and bounds are reviewed code/config. Only the existing owner/project and
approval services grant authority; a claimed reachability result is a reported
observation, never a safety conclusion.

**Primary risks and mitigations.**

| Risk                                                                                                | Mitigation                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSRF / internal pivot** (target an internal/metadata/loopback/link-local address)                 | Default-deny allowlist; resolve-then-recheck so a name cannot map to a blocked IP; reject `127.0.0.0/8`, `::1`, `169.254.0.0/16` (incl. `169.254.169.254`), `10/8`, `172.16/12`, `192.168/16`, ULA `fc00::/7`, and any non-allowlisted address, for both IPv4 and IPv6 (incl. IPv4-mapped). |
| **DNS rebinding** (allowlisted name resolves to a blocked IP, or changes between check and connect) | Resolve, validate every returned address against the allowlist, and connect to the _validated pinned_ address — never re-resolve between validation and use.                                                                                                                                |
| **Arbitrary execution / injection**                                                                 | No shell, no command/argument strings; parameters are typed enums/validated host+port only; adapters call library APIs, never a process.                                                                                                                                                    |
| **Scope creep into scanning**                                                                       | One target, one port, one attempt per action; ranges/sweeps rejected by schema; rate/concurrency ceiling.                                                                                                                                                                                   |
| **Secret / PII leakage**                                                                            | Digest-only receipts; bounded, secret-redacted summaries (reuse the education redaction discipline); no raw response bodies persisted.                                                                                                                                                      |
| **Authorisation forged from a prompt**                                                              | Authority only via the existing approval service and single-use claim; never inferred from prompt or model output; `assertNotPolicyEngineAuthority` enforced.                                                                                                                               |
| **Replay / double-effect**                                                                          | Reuse fingerprint-bound single-use consumption and receipt replay; reconciliation required for the external effect.                                                                                                                                                                         |

## Acceptance criteria mapping (#732)

- _Existing approval/policy cannot be bypassed_ → T3 + GovernedExternalOperation claim; no new effect channel.
- _Default deny; no wildcard targets or free-form shell_ → empty-by-default allowlist, typed params, library-only adapters.
- _Tests_ → out-of-scope/blocked target, SSRF ranges, DNS rebinding, IPv4/IPv6 (incl. mapped), timeout, cancellation (`AbortSignal`), rate/concurrency ceiling, approval replay, receipt redaction, allowlist-empty default-deny.
- _Audit logs/receipts redact_ → digest-only + redacted summaries.
- _CI passes; operator setup/rollback/recovery documented_ → operator doc + registry updates in the Stage 3 PR.
- _Development-only until owner authorises deployment_ → action families stay `planned`; no commissioning.

## Proposed registry shape (planning — not applied here)

New action families (e.g. `AM-016 tcp-check`, `AM-017 dns-lookup`, `AM-018 tls-inspect`),
`lifecycle_status: planned`, `policy_overlay: external_effect`,
`approval.mode: always` / `binding: exact_action_fingerprint`,
`execution.external_side_effects.mode: true`, `reconciliation.required: true`,
bound to new `TOOL-SECURITY-*` executor ids and the existing receipts state target,
with their own `TEST-*` / `EVD-*` ids. Tool-registry entries stay `planned` until a
reviewed allowlist binding is deployed to the authorised dev target and its
commissioning evidence gates pass.

## Gates before any Stage 3 code

1. Owner go/no-go on this design and the first-slice scope.
2. Dedicated branch/PR; coordinate per the AGENT COORDINATION convention; no overlap with other open work.
3. Draft PR only — no merge, no commissioning, no deployment, no allowlist population on a real target without explicit owner authorisation.

## Open questions for the owner

1. Is the three-diagnostic first slice (tcp-check / dns-lookup / tls-inspect) the right smallest scope, or narrower (e.g. tls-inspect only) to start?
2. Who owns and reviews the target allowlist, and where does it live (reviewed config file vs. a governed store)?
3. Should Stage 3 require a _second_ owner approval per target the first time it is used, on top of the per-action approval?
