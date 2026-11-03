# #732 Stage 3 — authorised diagnostics: design & threat model (planning only)

**Status: design approved by the owner (2026-11-04); scope narrowed to a TCP-only
first slice. No code, no production configuration, and no action-family lifecycle
change is made by this document.** It is the Stage 1 "discovery and design"
deliverable for the _next_ stage, written now that Stage 2 has landed. The owner's
decisions on the three design questions are recorded below. Building the Stage 3
code still requires a _separate_ implementation approval and a dedicated PR (per
#732's own gating); this revision exists so that review can run against the exact,
decided scope before that approval.

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
  advanced testing. This document covers **Stage 3 only** and, per the owner's
  decision, proposes the smallest safe diagnostics slice: a single TCP-connect
  check.

## Stage 3 objective (from #732)

> Reviewed, parameterised adapters for safe inventory and network diagnostics;
> explicit target allowlist (CIDR/IP/domain), bounded timeout/rate/concurrency,
> no arbitrary shell strings, immutable receipts and redaction.

The design goal is a capability that answers "is this _authorised_ target
reachable" through **reviewed code paths with no free-form execution**, reusing
every existing governance primitive rather than adding a new effect channel.

## Resolved decisions (owner, 2026-11-04)

1. **Scope — TCP-only first version.** The first slice is `security:tcp-check`
   _alone_. `dns-lookup` and `tls-inspect` are **deferred** to later slices, each
   its own design and approval; they are out of scope here. Rationale: `tcp-check`
   is the minimal external effect that still exercises the full governed boundary
   (claim → receipt → reconciliation) and the SSRF mitigations, while sending and
   reading zero application bytes and emitting only a status enum — the smallest
   surface that proves the pattern.
2. **Allowlist — reviewed repository file, changed through reviewed PRs.** The
   allowlist lives in the repo and is owned/reviewed by the owner; it is changed
   only via a reviewed PR, never at runtime and never from a prompt or model
   value. Default-deny and empty until populated. (A runtime governed store is
   explicitly _not_ adopted for Stage 3.)
3. **Approval — existing per-action approval only; no extra first-use approval.**
   The reviewed allowlist PR _is_ the deliberate per-target authorisation; the
   existing stage → approve (human, `exact_action_fingerprint`) path gates every
   individual call. No separate per-target first-use approval is added. (This is
   sound _because_ of decision 2; a runtime-mutable allowlist would have required
   one.)

### Approved parameters

- **Targets:** explicit **IP addresses only** to start. CIDR ranges are a later
  addition under their own change; the first slice's schema rejects ranges.
- **Ports:** each port is **explicitly approved per target** in the allowlist; a
  target does not implicitly authorise any port.
- **Limits:** **one** connection attempt per action; **5-second** timeout (tighter
  than the 30 s `MAX_TIMEOUT_MS` ceiling); **one** active check per owner at a
  time; at most **ten** checks per rolling minute.
- **Results:** exactly one of `connected` / `refused` / `timed-out` / `error`. **No
  banner grab, no application data read or sent.** Retries must **not** re-run a
  completed check — a finished action's receipt is replayed, never a fresh effect.

## Approved first slice — `security:tcp-check`

A single TCP _connect_ to one allowlisted `ip:port`, reporting
`connected` / `refused` / `timed-out` / `error`. **Not a port scanner:** one
target, one port, one attempt per action. **No raw sockets beyond the single
connect, no SYN scan, no shell, no user-supplied command or argument string, no
bytes sent, no bytes read.**

Anything broader — CIDR targets, DNS resolution, TLS/cert inspection, multi-port
sweeps, ranges, UDP probing, banners, scripts — is explicitly **out of this slice**
and would need its own design and approval.

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
- **External provider:** declare `externalProvider` on the
  `ToolExecutionDefinition` and register it via `externalProviderFor(tool, operation)`,
  so the diagnostics adapter is the only code that can emit this effect.
- **Staging/approval/receipts:** reuse the existing stage → approve (human,
  `exact_action_fingerprint`) → single-use consumption → immutable
  `toolExecutionReceipts` path. Receipts stay **digest-only and redacted**; no
  pasted or resolved value is echoed into a receipt, log, or answer beyond a
  bounded, secret-redacted summary (here just the status enum and the allowlisted
  `ip:port` already authorised).
- **Bounds (owner-decided):** per-action timeout **5 s** (not the 30 s
  `MAX_TIMEOUT_MS` ceiling); **1** in-flight check per owner; **≤10** checks per
  rolling minute; **1** connect attempt. Concurrency and rate ceilings are
  enforced **before** the claim is consumed.
- **Config:** the **target allowlist** (explicit IP + explicitly approved ports) is
  reviewed configuration, default-deny and empty until the owner populates it via a
  reviewed PR; it is not a model- or prompt-supplied value and cannot be widened at
  call time.

## Threat model

**Trust boundaries.** Caller input (target IP, port) is untrusted and validated
against the reviewed allowlist and strict schemas. The allowlist, adapter, and
bounds are reviewed code/config. Only the existing owner/project and approval
services grant authority; a `connected` result is a reported observation, never a
safety conclusion.

**Primary risks and mitigations.**

| Risk                                                                                | Mitigation                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSRF / internal pivot** (target an internal/metadata/loopback/link-local address) | Default-deny allowlist of explicit IPs; reject `127.0.0.0/8`, `::1`, `169.254.0.0/16` (incl. `169.254.169.254`), `10/8`, `172.16/12`, `192.168/16`, ULA `fc00::/7`, and any non-allowlisted address, for both IPv4 and IPv6 (incl. IPv4-mapped), even if an operator lists one — the allowlist cannot authorise them. |
| **DNS rebinding**                                                                   | **Out of scope by construction:** the first slice accepts only explicit IP literals and performs **no name resolution**. Rebinding re-enters the threat model only with the deferred `dns-lookup` slice, which must resolve → validate every address → connect to the validated pinned address, never re-resolve.     |
| **Arbitrary execution / injection**                                                 | No shell, no command/argument strings; parameters are a validated IP literal + an allowlisted integer port only; the adapter calls a library connect API, never a process.                                                                                                                                            |
| **Scope creep into scanning**                                                       | One target, one port, one attempt per action; ranges/CIDR/sweeps rejected by schema; 1-in-flight + 10/min ceilings.                                                                                                                                                                                                   |
| **Secret / PII leakage**                                                            | Digest-only receipts; status-enum-plus-authorised-`ip:port` summary only; no banner, no response bytes, nothing read from the socket.                                                                                                                                                                                 |
| **Authorisation forged from a prompt**                                              | Authority only via the existing approval service and single-use claim; never inferred from prompt or model output; `assertNotPolicyEngineAuthority` enforced.                                                                                                                                                         |
| **Replay / double-effect**                                                          | Reuse fingerprint-bound single-use consumption and receipt replay; a completed check is never re-run — its receipt is returned; reconciliation required for the external effect.                                                                                                                                      |

## Acceptance criteria mapping (#732)

- _Existing approval/policy cannot be bypassed_ → T3 + GovernedExternalOperation claim; no new effect channel.
- _Default deny; no wildcard targets or free-form shell_ → empty-by-default allowlist of explicit IP + approved ports, typed params, library-only adapter.
- _Tests_ → out-of-scope/blocked target, SSRF ranges (IPv4/IPv6 incl. mapped), CIDR/range rejection, 5 s timeout, cancellation (`AbortSignal`), 1-in-flight + 10/min ceilings, approval replay (completed check returns receipt, no second connect), receipt redaction, allowlist-empty default-deny, per-target port enforcement.
- _Audit logs/receipts redact_ → digest-only + status-enum summary; no banner/bytes.
- _CI passes; operator setup/rollback/recovery documented_ → operator doc + registry updates in the Stage 3 PR.
- _Development-only until owner authorises deployment_ → action family stays `planned`; no commissioning.

## Proposed registry shape (planning — not applied here)

One new action family for the first slice: `AM-016 tcp-check`,
`lifecycle_status: planned`, `policy_overlay: external_effect`,
`approval.mode: always` / `binding: exact_action_fingerprint`,
`execution.external_side_effects.mode: true`, `reconciliation.required: true`,
bound to a new `TOOL-SECURITY-TCP-CHECK` executor id and the existing receipts
state target, with its own `TEST-*` / `EVD-*` ids. (`AM-017 dns-lookup` /
`AM-018 tls-inspect` are reserved for the deferred slices, not defined here.) The
tool-registry entry stays `planned` until a reviewed allowlist binding is deployed
to the authorised dev target and its commissioning evidence gates pass.

## Implementation checklist (Stage 3 `tcp-check`)

Each item below is required in the implementation PR; review (Codex, then owner)
runs against this exact list. "Done" means implemented **and** covered by a test.

- [ ] Allowlist: reviewed repo file, schema-validated at load, default-deny, empty
      by default; entries are explicit IP literals each with an explicit set of
      approved integer ports; fail-closed on empty/invalid/missing.
- [ ] Schema: accept a single IP literal + single port; **reject** hostnames, CIDR,
      ranges, port lists/wildcards, and anything not on the allowlist.
- [ ] SSRF guard: reject loopback/link-local/metadata/private/ULA for IPv4, IPv6,
      and IPv4-mapped — independent of the allowlist (belt-and-braces).
- [ ] Effect: exactly one TCP connect attempt; **no** bytes written or read; socket
      closed immediately on connect result.
- [ ] Bounds: 5 s per-action timeout; `AbortSignal` cancellation honoured; 1
      in-flight check per owner; ≤10 checks per rolling minute; all enforced
      **before** the single-use claim is consumed.
- [ ] Governance: `minimumAuthority: "T3"`; `GovernedExternalOperation` +
      `externalProvider`/`externalProviderFor`; `assertNotPolicyEngineAuthority`;
      stage → approve (`exact_action_fingerprint`) → single-use → receipt →
      reconciliation.
- [ ] Result: one of `connected` / `refused` / `timed-out` / `error`; digest-only
      redacted receipt (status + authorised `ip:port` only).
- [ ] Idempotency: a completed action's retry **replays the receipt**, never a
      second connect.
- [ ] Registry: `AM-016` + `TOOL-SECURITY-TCP-CHECK` + `TEST-*`/`EVD-*`, all
      `planned`; no commissioning.
- [ ] Tests (per acceptance mapping above): allowlist default-deny, blocked/SSRF
      targets (v4/v6/mapped), CIDR/range/hostname rejection, per-target port
      enforcement, timeout, cancellation, concurrency + rate ceilings, approval
      replay, receipt redaction.
- [ ] Docs: operator setup/rollback/recovery; evidence doc; OpenAPI (if surfaced);
      all five required `main` checks green on the draft PR.

## Gates

1. **Owner go/no-go on design + first-slice scope — DONE (2026-11-04).** Scope,
   allowlist model, approval model, and bounds are decided (above).
2. **Review of this exact revision** (Codex) against the resolved scope and the
   implementation checklist, before any implementation.
3. **Separate implementation approval** from the owner, then a dedicated
   branch/PR; coordinate per the AGENT COORDINATION convention; no overlap with
   other open work.
4. **Draft PR only** — no merge, no commissioning, no deployment, and no allowlist
   population on a real target without explicit, separate owner authorisation.
