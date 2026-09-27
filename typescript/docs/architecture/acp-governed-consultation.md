# ACP governed consultation (PR H — governed commissioning slice)

## What this is

Earlier H slices built the ACP pieces bottom-up: the authority contract
(`acpContract.ts`, AUTH-INV-05), the transport seam (`acpTransport.ts`), the wire
framing (`acpMessage.ts`), the stdio transport (`acpStdioTransport.ts`), the
worker config resolver (`acpWorkerConfig.ts`), and the dormant live path
(`acpConsultation.ts`). This slice **wires a consultation into one real governed
decision site** — `GovernedExternalOperation.execute()`, the external-effect
choke point — under an explicit operating-mode policy, still **dormant-first**.

Nolan is the existing Jarvis system; this extends its architecture rather than
adding a second authority. ΩΣ / ToolAction remain authoritative; ACP is a
bounded judgement layer beneath them.

## The three layers (kept separate on purpose)

```
transport / consultation result   →  acpStdioTransport.ts (classified failures)
        │
        ▼
strict ACP interpretation          →  acpContract.ts / acpTransport.ts (UNCHANGED)
        │                              allow≠authority, deny=veto, failure=fail-closed
        ▼
operating-mode policy              →  acpOperatingMode.ts (disabled / advisory / required)
        │
        ▼
governed execution authority       →  ToolExecutionService atomic claim (UNCHANGED)
```

The strict primitive `consultAcpPeer()` / `resolveAcpAuthorization()` was **not
weakened** to add advisory mode. "Consultation failed" and "therefore the
operation must fail" are kept as different facts; only `required` mode makes the
second follow from the first.

## Operating modes (locked semantics)

| Governed approval | ACP result | disabled | advisory | required |
| ----------------- | ---------- | -------- | -------- | -------- |
| absent            | any        | BLOCK    | BLOCK    | BLOCK    |
| present           | allow      | PROCEED  | PROCEED  | PROCEED  |
| present           | abstain    | PROCEED  | PROCEED  | PROCEED  |
| present           | deny       | PROCEED  | PROCEED* | BLOCK    |
| present           | failure    | PROCEED  | PROCEED* | BLOCK    |

`*` advisory records a disagreement (deny) or the classified failure as
**evidence**; it never removes independently valid governed authority and never
grants authority. `disabled` never consults and never launches a worker.

Failure taxonomy (evidence, never authority): `unavailable`, `timeout`,
`worker_crash`, `malformed_response`, `request_mismatch`, `output_limit_exceeded`,
`internal_transport_error`. Unclassifiable → conservative
`internal_transport_error`.

## The authority signal (the critical part)

`GovernedExternalOperation.execute()` receives a `ToolAuthority` (`T0..T3`), which
is **not** proof of governed approval. The consultation's `governedApprovalPresent`
is derived instead from the ToolAction's own server-computed approval state —
`action.state === "approved" && action.isApprovalExpired !== true` — the same fact
`ToolExecutionService` checks. This is a **non-consuming eligibility read** placed
_in front of_ the authoritative execution-time gate.

The atomic claim / eligibility re-check inside `ToolExecutionService` still runs
immediately before the effect and re-validates the same fact against a fresh
transaction, so:

- ACP cannot manufacture authority (no approval ⇒ block, and the later gate would
  block anyway);
- ACP consultation runs **before** the effect and before any single-use claim, so
  a `required` block never invokes the provider and **never consumes** an
  approval;
- the earlier read never replaces the atomic gate, so the final boundary stays
  race-safe (no new TOCTOU).

On a block the boundary throws `AcpConsultationBlockedError` (a subclass of
`GovernedExternalOperationRefused`) carrying the evidence; on proceed it records
evidence via the optional `onAcpConsultation` observer (the telemetry seam) and
continues.

## Dormancy / rollback

Default `JARVIS_ACP_MODE` is unset ⇒ `disabled` ⇒ no consultation, no worker,
behaviour byte-identical to before. Rollback is configuration-level: set
`JARVIS_ACP_MODE=disabled` (or unset it / remove `JARVIS_ACP_WORKER_COMMAND`).
No database surgery, no receipt deletion, no ΩΣ/ToolAction change.

## Status

AUTH-INV-05 stays **planned**, not promoted. The enforcement point now exists and
is exercised offline, but nothing live routes through it (no worker configured,
`disabled` by default). Promotion awaits live commissioning evidence and an owner
decision — promoting here would overclaim.

## Files

- `src/acp/acpOperatingMode.ts` — pure mode policy + failure taxonomy.
- `src/acp/acpGovernedConsultation.ts` — classifying, mode-aware consultation.
- `src/acp/nolanAcpWorker.ts` — the worker reviewer adapter core (no live model).
- `src/actions/governedExternalOperation.ts` — the wired choke point.
- Tests: `tests/acpOperatingMode.test.ts`, `tests/acpGovernedConsultation.test.ts`,
  `tests/nolanAcpWorker.test.ts`, and the ACP block in
  `tests/governedExternalOperation.test.ts`.
- Host commissioning: `docs/operations/acp-worker-sandbox.md`,
  `docs/operations/acp-commissioning-evidence.md`.
