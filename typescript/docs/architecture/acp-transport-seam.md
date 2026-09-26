# ACP transport seam (PR H, slice 1)

## What this is

The acquisition plan brings ACP (Agent Communication Protocol) in as an
**acquired** capability that sits _underneath_ Jarvis authority: a peer agent's
permission response is advice, never authorisation (AUTH-INV-05). PR G already
froze that rule as a contract (`src/acp/acpContract.ts`,
`resolveAcpAuthorization`). This slice adds the **transport-agnostic seam** that
carries a permission request to a peer and routes the answer through that gate,
so no transport can bypass the rule.

It is deliberately separate from any wire transport. There is no stdio, HTTP, or
network here — only the abstraction (`AcpTransport`) and the consultation
function that enforces the authority boundary. The concrete wire transport, and
its network-egress decision (as with PR F), is a later slice.

## The boundary

`src/acp/acpTransport.ts`:

- `AcpTransport` — the interface a transport implements: `requestPermission(request) → AcpPermissionResponse`.
  Implementations carry the message; they hold no authority.
- `consultAcpPeer({ transport, request, governedApprovalPresent })` — the single
  entry point. It calls the transport, **normalises the answer fail-closed**, and
  routes it through `resolveAcpAuthorization`. The transport's raw answer is
  never returned as an authorisation.
- `InProcessAcpTransport` — a local, no-wire reference implementation (delegates
  to a handler) for tests and co-located agents.

Two fail-closed properties, enforced and tested:

1. **Every response passes through the AUTH-INV-05 gate.** A well-formed `allow`
   is inert on its own — authority still requires `governedApprovalPresent`.
2. **Malformed / mismatched / thrown → `abstain`.** A response that is missing,
   not an object, carries the wrong `requestId`, or has an unknown decision is
   treated as advisory-neutral. A broken or hostile transport therefore can
   never manufacture an `allow`, and can at most fail to cast a veto (a forged
   `deny` only blocks — fail-safe — it never authorises). It cannot inject
   authority.

Tests: `tests/acpTransport.test.ts` — allow+governed authorises; allow without
governed does not; deny vetoes even with governed; a throwing transport abstains
(never authorises alone, never blocks a governed-approved action); malformed and
mismatched responses are abstained; a well-formed allow is inert without the
governed gate. All offline, no network.

## Status

AUTH-INV-05 stays **planned**, not promoted. Nothing live routes through this
seam yet — this is the abstraction a wire transport must implement. Promoting it
would overclaim.

## Deliberately not in this slice

- **A wire transport** (stdio or HTTP) and its **network-egress decision**. This
  is the next H slice, and the decision mirrors PR F: deny-by-default egress,
  explicit allowed peers, no arbitrary hosts.
- **Wiring Claude/Codex onto ACP.** The seam is the prerequisite; moving the real
  agents onto it is the slice that lets AUTH-INV-05 advance toward enforced.
