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

1. **Every valid response passes through the AUTH-INV-05 gate.** A well-formed
   `allow` is inert on its own — authority still requires `governedApprovalPresent`.
2. **A failed/invalid consultation is indeterminate (blocked), not an abstention.**
   If the transport throws, or returns something missing, not an object, with the
   wrong `requestId`, or an unknown decision, `consultAcpPeer` resolves to _not
   authorised even when a governed approval is present_. This is deliberate:
   mapping a failure to `abstain` would let a crash, timeout, flood, or
   malformed/mismatched answer **suppress a veto** the peer would have cast once
   governed approval exists. Only an **explicit** `abstain` from a reachable peer
   defers to the governed decision. A broken or hostile transport can neither
   manufacture an `allow` nor erase a veto.

   > History: slice 1 originally mapped failures to `abstain`; the review of the
   > live stdio transport (PR #640) flagged that this suppressed a veto under a
   > present governed approval. The failure→blocked semantics above are the fix.

Tests: `tests/acpTransport.test.ts` — allow+governed authorises; allow without
governed does not; deny vetoes even with governed; a throwing/malformed/mismatched
consultation is **blocked even with governed approval present** (no veto
suppression); an explicit `abstain` defers to the governed decision; a well-formed
allow is inert without the governed gate. All offline, no network.

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
