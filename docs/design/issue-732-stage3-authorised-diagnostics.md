# #732 Stage 3 — authorised diagnostics: design & threat model (planning only)

**Status: owner has approved the TCP-only scope, the reviewed-file allowlist model,
the per-action approval model, and the bounds intent (2026-11-04); the design
details are under active review. Codex verdict on `90eed9a6` (repair required) was
addressed in `cd548120`; the advisory maintenance review then raised a second round
on `cd548120` (atomic policy binding, content-addressed table, fenced lease recovery,
canonical IP grammar), all addressed in this revision. No code, no production
configuration, and no
action-family lifecycle change is made by this document.** It is the Stage 1
"discovery and design" deliverable for the _next_ stage, written now that Stage 2
has landed. Building the Stage 3 code still requires a _separate_ implementation
approval and a dedicated PR (per #732's own gating); this revision exists so review
can run against the exact, decided scope before that approval.

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
   (claim → receipt → reconciliation) and the SSRF mitigations while performing no
   application-data reads or writes — the smallest surface that proves the pattern.
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

### Two mandatory, independent gates

A connect is admitted **only when both** of these pass — neither alone is
permission:

1. **Forbidden-address denial** against the vendored special-use table (below).
   Absence from the deny table is _necessary but not sufficient_.
2. **Explicit `(ip, port)` allowlist match** in the reviewed file.

## Approved first slice — `security:tcp-check`

A single TCP _connect_ to one allowlisted `ip:port`, reporting
`connected` / `refused` / `timed-out` / `error`. **Not a port scanner:** one
target, one port, one attempt per action. **No raw sockets beyond the single
connect, no SYN scan, no shell, no user-supplied command or argument string, and no
application-data reads or writes — TCP connection establishment itself exchanges
protocol packets; nothing is read from or written to the established socket.**

Anything broader — CIDR targets, DNS resolution, TLS/cert inspection, multi-port
sweeps, ranges, UDP probing, banners, scripts — is explicitly **out of this slice**
and would need its own design and approval.

### Approved parameters

- **Targets:** explicit **IP literals only** to start (IPv4 given as IPv4 literals;
  IPv4-mapped/transition IPv6 forms rejected — see special-use policy). CIDR ranges
  are a later addition under their own change; the first slice's schema rejects
  ranges.
- **Ports:** each port is **explicitly approved per target** in the allowlist; a
  target does not implicitly authorise any port. The canonical `(ip, port)` and the
  server-computed `allowlistDigest` are bound into the action args that feed the
  `exact_action_fingerprint` (R3), so an approval authorises exactly that port
  under exactly that policy — never the host generally, never an unlisted port.
- **Timeout / attempt:** **one** connection attempt per action; **5-second**
  timeout (tighter than the 30 s `MAX_TIMEOUT_MS` ceiling); `AbortSignal` cancellation
  honoured. The deadline is **enforced by the supervised egress mediator on the socket
  it owns**, not by a worker-local timer — a worker's own timer is frozen while it is
  suspended and so cannot bound a late effect. A worker suspended past its capability's
  lifetime resumes to an **expired capability**: the mediator opens nothing, and the
  attempt reconciles as `uncertain`, **never** reported as a late `connected` or
  `timed-out` (R1/R4).
- **Rate & concurrency (R1):** at most **one** active check per owner, and at most
  **ten** _started_ attempts per owner per rolling **60 s** window _(proposal:
  window semantics)_ — see the admission-control subsection; the started-attempt
  history is **never refunded** on any terminal outcome.
- **Results:** a network result is exactly one of `connected` / `refused` /
  `timed-out` / `error` (R5); a pre-execution **rejection** is a _separate_ typed
  outcome, never reported as a network result. Retries must **not** re-run a
  completed check — a finished action's receipt is replayed, never a fresh effect.

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
  so the diagnostics adapter is the only code that can emit this effect. The adapter
  does not open the socket itself: it emits through the **supervised egress mediator**
  (the enforcement point of record — see Admission control R1), which runs the final
  connect-time check and owns the socket.
- **Staging/approval/receipts:** reuse the existing stage → approve (human,
  `exact_action_fingerprint`) → single-use consumption → immutable
  `toolExecutionReceipts` path. Receipts stay **digest-only and redacted**; no
  pasted or resolved value is echoed into a receipt, log, or answer beyond a
  bounded, secret-redacted summary (the status enum and the allowlisted `ip:port`
  already authorised).
- **Config:** the **target allowlist** (explicit IP + explicitly approved ports)
  plus the vendored special-use table are reviewed configuration, default-deny and
  empty until the owner populates the allowlist via a reviewed PR; neither is a
  model- or prompt-supplied value and neither can be widened at call time.

### Admission control — active slot vs. durable rate history (R1)

Two **separate** pieces of state per owner, because releasing the concurrency slot
must not refund the rate budget (otherwise eleven fast sequential connects could
each reacquire a refunded token and defeat the ten-per-minute cap):

- **Active slot** (at most 1 per owner): released on a **recorded** terminal state
  whose effect executor is known to have stopped — `completed`, `failed`,
  `timed-out`, `cancelled`. It is **not** released by lease expiry alone, and an
  `uncertain` outcome **holds** the slot (see crash recovery below): releasing on a
  mere timer would let a new attempt overlap an executor that may still connect.
- **Durable started-attempt history:** a record is written when an attempt moves to
  `started`, and it counts toward the cap until it is 60 s old. It is **never
  refunded** on completion, `error`, `timed-out`, or cancellation. Maximum **10**
  started attempts per owner per rolling 60 s _(proposal: window semantics)_.
- **Reservation is one atomic step:** in a single atomic compare-and-set (under the
  JSON `.lock`; a single Convex mutation), check "no active slot AND history
  count < 10", then take the slot and append a `reserved` history entry. Owner-wide
  across all workers. This runs **before** the single-use claim is consumed.
- **`reserved` → `started` only immediately before connect; `started` is written
  durably *before* the socket opens.** Two distinct, non-conflicting release paths:
  - **Self-cleanup (live worker):** a worker that hits a *synchronous* pre-effect
    rejection (`policy_changed`, claim failure, schema reject) before flipping to
    `started` releases **its own** reservation at once and removes the `reserved`
    entry — it is alive and has provably opened no socket. Consumes no budget.
  - **Recovery of a *stale* reservation** (the worker crashed or was suspended without
    self-cleaning) is **not** a blind release; it is governed by the crash-recovery
    rule below, which keys off the record's durable phase.
- **Crash recovery — the slot is held until termination is *proven*, never reclaimed
  on a timer** _(proposal: ≤ 4 s connect deadline, strictly shorter than the 5 s
  lease; 10 s grace)_: a recovering party cannot observe or cancel another worker's
  socket, and a worker suspended (SIGSTOP / pathological GC pause) past lease+grace
  has a **frozen** deadline timer, so a hard local deadline **cannot** be relied on to
  bound a suspended executor's effect. The design therefore does **not** reclaim the
  owner-wide slot by lease expiry or by any storage-only fence. A stale record found
  by recovery is resolved by its **durable phase**, which is the single rule that
  governs every unobservable crash:
  - **stale `reserved` (no durable `started`):** the socket **provably never opened**
    (`started` precedes connect). Recovery performs a **fenced cleanup** — a write that
    supersedes the reservation's fence token and releases the slot — sound *only*
    because a resumed worker bearing the superseded token can neither write `started`
    nor connect. This is the one path that releases without a supervisor, and it is
    valid precisely because connect is gated behind the durable `started` write.
  - **stale `started` (the mediator may have opened a socket):** becomes durable
    **`uncertain`** and **keeps holding the active slot**. Because the socket is the
    **mediator's** (effects are emitted only through it — see the egress-mediator rule
    below), the slot is released — and only then may a new attempt be admitted — on the
    mediator's own durable **socket-closed** signal for that capability, i.e. a
    **termination proof the mediator can actually produce** rather than infer about a
    worker it cannot see.

  Lease expiry and fencing storage writes are **necessary but not sufficient** in the
  `started` case; they gate storage writes, not the OS effect — only the mediator,
  which owns the socket, can signal it closed.
- **Why this keeps at-most-one-active-check literally true.** Because the slot is not
  reused until the prior executor is proven terminated, no second executor is ever
  admitted for an owner while the first may still connect. A worker that resumes from
  suspension is **the same single executor**, connecting late — not a second one — so
  there is never more than one admitted executor per owner. The residual is purely
  one of **timing** (one executor may connect later than expected), never of **count**
  (there is never a second concurrent connect, and stragglers cannot accumulate).
- **Fencing covers the storage path; the fence token guards result commits.** Each
  reservation carries a monotonic fencing token; `reserved → started` is the fence
  checkpoint, and **terminal results are committed only while the token is still
  held** — recovery's `started → uncertain` write supersedes the token, so a resumed
  straggler can neither record `started` nor commit a late `completed` (no invented or
  post-recovery success).
- **Enforcement is out-of-band — the effect is emitted through a supervised egress
  mediator, not a direct worker `connect()`.** Any check a worker runs in its **own**
  userspace *before* `connect()` — freshness, the 5 s deadline, even digest/epoch —
  can be defeated by a suspension between the check and the syscall, so an in-worker
  check can never be the enforcement point of record. The worker therefore does **not**
  open the socket. It presents a short-lived **effect capability** — bound to the
  pinned `(ip, port)`, `allowlistDigest`, epoch, the snapshot's **freshness deadline**,
  and the reservation's fence token — to the **supervised egress mediator**, which
  performs the **authoritative final check at the instant of connect** (target ∈
  allowlist under the *currently active* policy, table within its freshness bound,
  capability unexpired, fence token active) and only then opens the socket and enforces
  the 5 s deadline on the socket **it owns**. The in-worker fenced check (R3) stays as
  a cheap early-reject, not the guarantee.
- **Why suspension can no longer defeat a check.** A worker suspended after the fenced
  `reserved → started` step holds no socket; on resume its capability has expired
  (freshness/lease elapsed) and the mediator refuses, so it can never cause a connect
  under an expired table, a superseded policy, or past the deadline. And because the
  mediator **owns the socket**, socket termination is **directly observed** by the
  mediator — the earlier "cannot inspect another worker's socket" problem does not
  arise for the effect itself; the slot is released on the mediator's own
  socket-closed signal. (The mediator is the trusted enforcement boundary, like a
  governed egress proxy; its robustness is the commissioning bar, below.)
- **Fail-closed, and a prerequisite for commissioning.** The supervised egress
  mediator is the enforcement point of record: it performs the final connect-time
  check, owns and deadline-bounds the socket, and signals its closure. Absent such a
  mediator **no effect may be emitted at all** — the capability has nowhere
  enforceable to go — and after any `uncertain` the owner's slot stays held until the
  mediator signals closure; the owner can run no new check until then. For a
  1-active/owner, 10-per-60 s diagnostic this is an acceptable **liveness** cost and is
  strictly preferable to relaxing the concurrency, freshness, or policy limits. The
  enforceable **supervised egress mediator** is therefore a **commissioning
  prerequisite**, not an implementation detail (see Gates).
- **Adversarial recovery cases (required tests):** (a) suspension *before* connect —
  the stale-token worker cannot record `started`, so it never connects; (b) suspension
  *after* the fenced `reserved → started` but before the mediator connects — on resume
  the capability has expired, the mediator refuses, so no socket opens (and, if the
  table freshness bound passed in the interval, the mediator refuses even with matching
  digest/epoch); (c) suspension *with an open socket* — the slot stays held as
  `uncertain` until the mediator signals that socket closed; no new attempt is
  admitted; the straggler's eventual result write is fenced out; (d) *repeated*
  recoveries — each leaves the slot held, so stragglers cannot accumulate into multiple
  concurrent executors.

## Special-use address policy (R2)

The CIDRs named anywhere in this document are **examples / a floor**, not the
policy. The policy is a **reviewed static table vendored in the repo**, derived
from the IANA IPv4 and IPv6 Special-Purpose Address Registries (RFC 6890 and its
updates), recording the registry **snapshot date** _(proposal: table authority and
snapshot process)_. The table is **content-addressed** (its digest is part of
`allowlistDigest`, R3) and governs — not prose.

**Integrity against an independently trusted anchor (not self-consistency).** Hashing
the loaded table and folding that hash into `allowlistDigest` proves only that the
table matches *its own* declared digest — it cannot detect a table edited **together
with** its declared digest. Integrity is therefore checked against an **independently
trusted expected digest** that does not travel with the table: a reviewed constant
committed in code **separate from** the table file (so changing the table requires a
matching, separately-reviewed change to the anchor in the same PR — git review and
history are the trust root), optionally strengthened later by a detached signature or
release anchor. At load the loader recomputes the table digest and **fails closed**
(deny-all) unless it equals the trusted anchor. `allowlistDigest` still binds the
table contents for policy-identity (R3), but the anchor — not `allowlistDigest` — is
what establishes the table is the reviewed one.

**Fail-closed on staleness, re-checked at admission (not only at load).** If the
table's snapshot is older than a reviewed freshness bound, or fails the anchor check
above, **all** allowlist use is blocked (deny-all). Crucially, freshness is **not**
only a load-time gate: a reservation pins the snapshot's **freshness deadline**, the
in-worker fenced pre-connect check (R3) re-evaluates it as an early reject, and — the
**authoritative** check — the **supervised egress mediator re-evaluates freshness at
the instant of connect** on the socket it owns (R1). A worker that pauses right after
the fenced check and resumes **after** the freshness bound therefore still opens no
socket: its capability is expired and the mediator refuses, even though its digest and
epoch are unchanged. A newly allocated special-use range can thus never be reached
merely because it is absent from an out-of-date table, nor by a worker that paused
across the freshness boundary between the check and the syscall.

- **Default deny:** an address is permitted only if it is **not** in the table
  **and** matches the `(ip, port)` allowlist (the two mandatory gates). The
  allowlist can never override the table.
- **Translation/transition forms rejected in this slice:** `::ffff:0:0/96`
  (IPv4-mapped), `::/96` (compat), `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64),
  `2002::/16` (6to4), `2001::/32` (Teredo), `2001:db8::/32` (documentation), and
  other special-purpose allocations per the table. IPv4 targets must be supplied as
  IPv4 literals.
- **Parse rules & normative canonical grammar:** exactly one accepted textual form
  per address — IPv6 per **RFC 5952** (lowercase, maximal `::` compression, no
  leading zeros), IPv4 as dotted-quad with **no leading zeros** and no octal/hex/
  integer spellings; embedded/compat/mapped IPv6 forms and any non-minimal spelling
  are **rejected, not rewritten**; zone identifiers (`%…`) and brackets rejected. The
  **same canonical byte form** is used identically in validation, the deny/allowlist
  checks, the fingerprint, and the socket target — the socket is opened only to the
  exact canonical address that was checked; there is no DNS resolution and no
  fallback.

## Threat model

**Trust boundaries.** Caller input (target IP, port) is untrusted and validated
against the vendored special-use table, the reviewed allowlist, and strict schemas.
The table, allowlist, adapter, and bounds are reviewed code/config. Only the
existing owner/project and approval services grant authority; a `connected` result
is a reported observation, never a safety conclusion.

**Primary risks and mitigations.**

| Risk                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSRF / internal pivot** (internal/metadata/loopback/link-local target) | Canonicalize first (reject non-canonical/ambiguous/zone-ID/bracketed forms; no rewrite); deny against the vendored special-use table **before and independent of** the allowlist; then require an explicit `(ip, port)` allowlist match. Both gates mandatory; connect only to the exact canonical address checked; no DNS, no fallback. |
| **DNS rebinding**                                                        | **Out of scope by construction:** IP literals only, no name resolution. Re-enters only with the deferred `dns-lookup` slice (resolve → validate every address against table + allowlist → connect to the validated pinned address, never re-resolve).                                                                                    |
| **Arbitrary execution / injection**                                      | No shell, no command/argument strings; parameters are a validated canonical IP literal + an allowlisted integer port only; the effect is a single library connect through the supervised egress mediator, never a process.                                                                                                                                                     |
| **Unintended-port / lateral reach**                                      | Ports allowlisted **per target**; `(ip, port)` + `allowlistDigest` bound into the fingerprint; a host never implicitly authorises a port.                                                                                                                                                                                                |
| **Rate-limit evasion by refund**                                         | Started-attempt history is durable and never refunded; the active slot is separate; atomic owner-wide reservation (R1).                                                                                                                                                                                                                  |
| **Scope creep into scanning**                                            | One target, one port, one attempt per action; ranges/CIDR/sweeps rejected by schema; 1-in-flight + 10/60 s started-attempt ceiling.                                                                                                                                                                                                      |
| **Stale-policy effect**                                                  | Immutable, content-addressed policy snapshot (`allowlistDigest` over allowlist **contents** + full special-use table **contents**) pinned at reservation under a monotonic policy epoch; the final digest+epoch check is fenced into the `reserved→started` flip; a target-narrowing change is **staged** and activates only through the owner-wide barrier once no effect pinned to the target is admitted or `uncertain`, so an executor only connects under then-active policy and a connect never reaches a newly-denied target; the fenced check also re-evaluates the pinned snapshot's **freshness deadline** (a reservation paused past the staleness bound is refused); table integrity is verified against an **independently trusted anchor**, not self-consistency, failing closed (R2/R3).                                        |
| **Uncertain / double effect**                                            | Durable `started` before connect; completed ⇒ receipt replay; `started`-without-result ⇒ `effect_uncertain`, reported blocked, **no reconnect, no invented success** (R4); an `uncertain` attempt **holds** the owner-wide slot (never reclaimed by lease/timer) until the supervised egress mediator (which owns the socket) signals it closed, so no second executor is ever admitted — one-active-check holds by count, the residual is only timing (R1); terminal-result commit is fenced on the active token and recovery's `→ uncertain` write supersedes it, so a resumed straggler cannot commit a late `completed` (R1/R4); single-use consumption + reconciliation.                                                                                                                      |
| **Secret / PII leakage**                                                 | Digest-only receipts; status-enum + authorised `ip:port` only; no banner, no socket reads, no raw OS/errno text, no stack traces (R5).                                                                                                                                                                                                   |
| **Authorisation forged from a prompt**                                   | Authority only via the existing approval service + single-use claim; `allowlistDigest` computed server-side, caller-supplied values ignored/rejected; `assertNotPolicyEngineAuthority` enforced.                                                                                                                                         |

## Policy-identity binding (R3)

Binding the canonical `(ip, port)` alone is insufficient — the _policy under which
it was approved_ must also be bound, so a post-approval allowlist change cannot be
exploited:

- **Extend the existing action args** (which already feed `fingerprintToolAction` /
  `fingerprintToolEffect`) with canonical `ip`, `port`, and `allowlistDigest`. This
  is **not** a parallel approval mechanism. _(proposal: exact field names not yet
  checked against the code.)_
- **Trusted source (content-addressed):** `allowlistDigest` is computed
  **server-side** by the loader — a SHA-256 over the canonical serialisation of the
  loaded allowlist file **and the full contents of the vendored special-use table**
  (the table contents, not merely a version string, so any table edit changes the
  digest). Callers cannot supply it; a caller-supplied value is ignored or rejected.
- **Immutable policy snapshot pinned through connect, under a monotonic policy
  epoch.** Each reviewed policy deploy publishes a durable, monotonically increasing
  **policy epoch** alongside its content digest. At reservation the loader pins an
  immutable in-memory snapshot (allowlist + table) and records the epoch it was taken
  from **and the snapshot's freshness deadline** (R2). `allowlistDigest`, the epoch,
  and freshness are re-derived/re-read at staging, at approval, in the **same atomic
  fenced step** that flips `reserved → started` (a cheap early reject), and — the
  **authoritative** check — again at the **supervised egress mediator** at the instant
  of connect (R1), since only a check the suspendable worker cannot bypass is
  enforceable. If at the fenced step the live digest
  differs from the approved one, the live epoch is newer than the pinned one, the
  `(ip, port)` entry is absent from the current policy, **or the pinned snapshot has
  passed its freshness deadline** (so a reservation that paused across the staleness
  bound cannot resume and connect on an expired table), the transition is refused:
  return `policy_changed`, open no socket, clean up the reservation (R1); a new stage
  + approval are required.
- **Policy activation is serialized with effect admission — a staged→active barrier.**
  A userspace epoch read cannot be made atomic with the kernel's `connect()`, so
  atomicity is not asserted at the syscall; it is enforced at **activation ordering**
  instead. A reviewed policy deploy is first **staged**, and **activates** (bumps the
  epoch that admission checks see) only through the same owner-wide barrier that
  governs admission, under this rule: **a policy change that removes or narrows a
  target does not activate while any effect pinned to the affected target is admitted
  or `uncertain`.** Such effects run to a recorded terminal state — or, for
  `uncertain`, until the supervisor proves executor+socket termination (R1) — under
  the **last-activated** snapshot *before* the narrowing activates. Conversely, once a
  change activates, the fenced `reserved → started` check sees the newer epoch and
  refuses admission (`policy_changed`, no socket).
- **Why a connect can never reach a newly-denied target.** An executor only ever
  connects under the snapshot that was *active* when it was admitted, and a
  target-removing change cannot activate while an executor pinned to that target may
  still connect. So there is no "pinned-but-superseded" connect to a now-denied
  target: either the effect connected while its target was still active policy, or the
  change activated first and no socket opened. A suspended straggler is covered by the
  same barrier — its removal stays *staged* (not active) until the supervisor proves
  the straggler terminated, so the straggler can only ever have connected under
  still-active policy. The cost is **liveness**: a narrowing activation (and any new
  check it gates) can be delayed until supervised termination — a documented property,
  not a silent residual.

## Uncertain-effect & recovery (R4)

Completed-receipt replay is not enough: a crash after the socket opens but before
the result is durably recorded must not be resolved by reconnecting.

- **Durable state in the existing claim/receipt/reconciliation storage**, keyed by
  the claim identity: `reserved → started → completed(outcome)`, or `uncertain`.
  _(proposal: exact mapping onto the receipt schema not yet checked.)_
- `started` is written **durably before** the socket opens.
- **Completed** ⇒ return the stored bounded result; **do not connect.**
- **`started` with no result, found on retry/restart** ⇒ mark `uncertain`, report
  **blocked** with `effect_uncertain`; **do not reconnect**, do not invent
  `connected` or any success. A TCP observation cannot be queried after the fact, so
  reconciliation here means **recording that the effect is unknown**, not
  re-probing. A new check needs a new stage + approval.
- **Reservation recovery:** an `uncertain` attempt **holds** the active slot — it is
  **not** released by lease/grace expiry or by any storage fence, because the effect is
  the mediator's socket, not a worker timer. Since the effect is emitted only through
  the **supervised egress mediator**, which owns the socket, the slot is released — and
  a new attempt admitted — on the mediator's durable **socket-closed** signal for that
  capability (a termination proof it can actually produce). The terminal-result commit
  is fenced on the active token, and the `started → uncertain` write supersedes it, so
  a straggler cannot commit a late `completed` after recovery (R1). The `started`
  history entry **keeps counting** throughout (R1). Absent the mediator no effect may
  be emitted and the slot stays held (fail-closed liveness), which is why the mediator
  is a commissioning prerequisite (see Gates).

## Result & rejection contract (R5)

- **Network results** (an effect actually started): `connected`, `refused`,
  `timed-out`, `error`. One spelling used everywhere (`timed-out`). `error` carries
  an optional bounded `reason` _(proposal)_: `unreachable`, `aborted`, `internal`.
- **OS-error → enum mapping** _(proposal)_:

  | Condition                      | Result                  |
  | ------------------------------ | ----------------------- |
  | connect success                | `connected`             |
  | `ECONNREFUSED`                 | `refused`               |
  | deadline reached               | `timed-out`             |
  | `ENETUNREACH` / `EHOSTUNREACH` | `error` / `unreachable` |
  | caller abort                   | `error` / `aborted`     |
  | anything else                  | `error` / `internal`    |

- Raw errno strings, OS error text, stack traces, and remote bytes are **never** put
  in answers, logs, or receipts.
- **Pre-execution rejections are a separate type**, never reported as a network
  result and consuming **no** budget (except `effect_uncertain`, whose earlier
  `started` entry still counts): `invalid_target`, `invalid_port`,
  `forbidden_address`, `not_allowlisted`, `port_not_allowed`, `policy_changed`,
  `not_approved`, `claim_consumed`, `rate_limited`, `concurrency_limited`,
  `effect_uncertain`.

## Acceptance criteria mapping (#732)

- _Existing approval/policy cannot be bypassed_ → T3 + GovernedExternalOperation claim; `allowlistDigest` bound + revalidated at admission; no new effect channel.
- _Default deny; no wildcard targets or free-form shell_ → vendored special-use table (deny) **and** explicit `(ip, port)` allowlist (permit), both mandatory; typed params; library-only adapter.
- _Tests_ → table-driven special-use coverage (one case per row, first/last address, neighbours just outside each range, a test that fails if a row is removed; canonicalisation + zone-ID/bracket rejection; translation/transition forms); CIDR/range/hostname rejection; per-target port + fingerprint/digest binding; 5 s timeout; cancellation (`AbortSignal`); **eleven sequential fast outcomes inside 60 s → the eleventh is `rate_limited`**; window roll-over resumes admission; simultaneous requests at both limits admit exactly one / exactly ten; unstarted reservation cleaned up and consumes nothing; **policy swap/removal observed at/before the fenced pre-connect check ⇒ no socket opens (`policy_changed`); a digest-change test asserts any table-row edit changes `allowlistDigest`**; a **target-narrowing activation stays staged while an effect pinned to that target is admitted or `uncertain`, then activates** (paused-worker + target-removal timeline: a worker paused before a removal, resumed after, connects only under the then-active snapshot — never the removed target); forged caller digest not honoured; **a table whose contents are edited together with its declared digest fails the trusted-anchor check (deny-all); a reservation that pauses past the freshness deadline is refused at the fenced pre-connect check (`policy_changed`) despite unchanged digest/epoch; a worker suspended **after** the fenced check and resumed past the freshness/lease bound presents an expired capability and the mediator opens no socket (deadline and freshness are enforced by the mediator at connect, not a worker-local timer)**; **crash after `started` ⇒ `uncertain`/blocked, no socket; the slot stays held until a supervised termination proof, so no second executor is admitted; a straggler resuming after recovery cannot commit a late `completed` (result-commit fence)**; a stale `reserved` (never-`started`) recovery releases via fenced cleanup and a resumed stale-token worker cannot then `start`/connect; adversarial recovery cases — suspension *before* connect (never connects), suspension *with an open socket* (slot held, no new admission), *repeated* recoveries (stragglers never accumulate into concurrent executors); cancellation mid-connect destroys socket, releases slot, keeps history; completed-result replay opens no socket; receipt redaction; allowlist-empty default-deny.
- _Audit logs/receipts redact_ → digest-only + status-enum summary; no banner, no socket bytes, no raw OS/errno text.
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

## Review response — Codex findings on `90eed9a6`

Addressed in this revision (pending re-review); nothing claimed resolved until
Codex re-reviews the new candidate. Earlier `jarvis-pr-maintenance` advisory
findings are folded into these.

- **R1 — rate history refunded with the concurrency slot (medium)** — addressed:
  separate active slot vs. durable, never-refunded started-attempt history; atomic
  owner-wide reservation; `reserved`/`started` lifecycle + lease recovery; tests
  incl. eleven sequential outcomes.
- **R2 — deny list claimed complete but is not (medium)** — addressed: the deny
  CIDRs are a floor only; a **vendored IANA special-use table (dated)** governs;
  translation/transition forms rejected; canonical-only parsing; table-driven
  tests. "Full IANA set"/"resolved" claims removed.
- **R3 — policy identity not bound (medium)** — addressed: server-computed
  `allowlistDigest` (allowlist file + **full special-use table contents**, not a
  version string) added to the fingerprinted action args and revalidated at
  staging/approval/admission under a monotonic policy epoch; `policy_changed` on
  digest or epoch mismatch; a test asserts any table-row edit changes the digest.
- **R4 — uncertain attempt & reservation recovery (medium)** — addressed: durable
  `reserved → started → completed|uncertain`; `started` before connect; no reconnect
  and no invented success on `uncertain`; slot recovered via lease, history retained.
- **R5 — result/error contract & wording (medium)** — addressed: "no bytes" reworded
  to "no application-data reads/writes; establishment exchanges protocol packets";
  fixed network-result enum + optional bounded `reason`; OS-error mapping; typed
  pre-execution rejection list distinct from network results; no raw OS text in
  receipts.
- **Deferred-slice findings (not dropped):** domain-matching canonicalisation
  (`dns-lookup`), DNS output bounds (`dns-lookup`), TLS ClientHello/SNI + cert-
  validity reporting (`tls-inspect`) remain hard requirements on those designs.

## Implementation checklist (Stage 3 `tcp-check`)

Each item is required in the implementation PR; review (Codex, then owner) runs
against this exact list. "Done" means implemented **and** covered by a test.

- [ ] Allowlist: reviewed repo file, schema-validated at load, default-deny, empty
      by default; entries are explicit IP literals each with an explicit set of
      approved integer ports; fail-closed on empty/invalid/missing.
- [ ] Special-use table: vendored, dated, IANA-derived; **deny runs before and
      independent of** the allowlist; both gates mandatory (absence from the table
      is not permission); translation/transition forms rejected; table-driven tests
      incl. a test that fails if a row is removed. **Integrity against an
      independently trusted anchor** (a reviewed expected-digest constant committed
      separately from the table, not shipped with it); load fails closed (deny-all) on
      anchor mismatch or when the snapshot is past its reviewed **freshness bound**.
- [ ] Schema & parsing: single canonical IP literal + single port; reject hostnames,
      CIDR, ranges, port lists/wildcards, zone IDs, brackets, non-canonical forms
      (reject, never rewrite); socket opens only to the exact canonical address
      checked; no DNS, no fallback.
- [ ] Admission control (R1): separate active slot (released only on a recorded
      terminal state whose executor is known stopped — **never** on lease/timer alone)
      and durable started-attempt history (never refunded, counts 60 s); single
      atomic owner-wide reservation before the claim; `reserved`→`started` (fence
      token re-verified in the same atomic step) only just before connect; per-attempt
      connect deadline strictly < lease _(proposal: ≤ 4 s deadline < 5 s lease; 10 s
      grace)_; recovery keyed on durable phase — a stale `reserved` (no `started`)
      releases via **fenced cleanup** (token superseded, so a resumed worker cannot
      `start`/connect; sound because connect is gated behind the durable `started`
      write), while a stale `started` becomes `uncertain` and **holds** the slot until
      the supervisor (below) proves termination — no reuse on a timer.
- [ ] Supervised egress mediator (R1/R3) — enforcement point of record: the worker
      does **not** open the socket; it presents a short-lived capability (bound to
      `(ip, port)`, `allowlistDigest`, epoch, freshness deadline, fence token) to the
      mediator, which runs the **final connect-time check** (target ∈ active-policy
      allowlist, table fresh, capability unexpired, token active), owns and
      deadline-bounds the socket, and signals its closure (the termination proof). A
      suspend between any in-worker check and the syscall cannot bypass it. Absent the
      mediator, **no effect may be emitted** (fail closed). Commissioning prerequisite;
      covered by the adversarial recovery tests.
- [ ] Policy binding + activation ordering (R3): server-computed `allowlistDigest`
      (allowlist + **full special-use table contents**, not a version string) in the
      fingerprinted args; re-derived at staging/approval and in the fenced
      `reserved→started` step under a monotonic policy epoch; the fenced check also
      re-evaluates the pinned snapshot's **freshness deadline**, so a reservation
      paused past the staleness bound is refused despite unchanged digest/epoch;
      `policy_changed` + no socket on digest/epoch/freshness mismatch observed
      at/before that check; caller-supplied digest ignored; a test asserts any
      table-row edit changes the digest. A
      target-narrowing deploy is **staged** and activates only through the owner-wide
      barrier once no effect pinned to the target is admitted or `uncertain`, so an
      executor only connects under then-active policy (never a newly-denied target).
- [ ] Effect: exactly one TCP connect attempt, emitted **through the supervised egress
      mediator** (never a direct worker socket); no application-data reads/writes;
      5 s deadline enforced by the mediator on the socket it owns (not a worker-local
      timer); socket closed immediately on result; a worker suspended past its
      capability lifetime opens nothing and reconciles as `uncertain`.
- [ ] Uncertain-effect (R4): durable `started` before connect; completed ⇒ replay,
      no connect; `started`-without-result ⇒ `effect_uncertain`/blocked, no
      reconnect, no invented success; slot **held** until supervised termination
      (not reclaimed on a timer), history retained; terminal-result commit fenced on
      the active token so a straggler's late `completed` write after recovery marked
      the attempt `uncertain` is rejected.
- [ ] Result/rejection contract (R5): network enum `connected`/`refused`/
      `timed-out`/`error`(+`reason`); OS-error mapping; typed pre-execution rejection
      list distinct from network results, consuming no budget; no raw OS/errno/stack
      text anywhere.
- [ ] Governance: `minimumAuthority: "T3"`; `GovernedExternalOperation` +
      `externalProvider`/`externalProviderFor`; `assertNotPolicyEngineAuthority`;
      stage → approve (`exact_action_fingerprint`) → single-use → receipt →
      reconciliation.
- [ ] Receipts: digest-only, redacted (status + authorised `ip:port` only).
- [ ] Registry: `AM-016` + `TOOL-SECURITY-TCP-CHECK` + `TEST-*`/`EVD-*`, all
      `planned`; no commissioning.
- [ ] Tests: per the acceptance mapping — special-use table coverage, canonical/
      zone-ID/bracket rejection, CIDR/range/hostname rejection, per-target port +
      digest binding, timeout, cancellation, eleven-sequential + window roll-over +
      simultaneous reservation, unstarted cleanup, policy swap after approval,
      staged→active target-narrowing with a paused-worker + target-removal timeline,
      forged digest, crash-after-`started`, the adversarial recovery cases (suspension
      before connect, suspension with an open socket, repeated recoveries → slot held,
      no second executor), supervised-termination slot release, cancellation
      mid-connect, completed replay, receipt redaction, allowlist-empty default-deny.
- [ ] Docs: operator setup/rollback/recovery; evidence doc; OpenAPI (if surfaced);
      all five required `main` checks green on the draft PR.

## Owner policy decision flagged

With no exception mechanism, private/ULA targets (the owner's own LAN) **cannot** be
diagnosed, because the special-use table denies them before the allowlist. The
owner-decided default-deny stays; any exception mechanism (e.g. an explicitly
owner-carved LAN range) needs its own separate design and approval and is **not**
part of this slice.

## Gates

1. **Owner go/no-go on scope + allowlist/approval model + bounds intent — DONE
   (2026-11-04).**
2. **Review of this exact revision** (Codex) against the resolved scope and the
   implementation checklist, before any implementation.
3. **Separate implementation approval** from the owner, then a dedicated
   branch/PR; coordinate per the AGENT COORDINATION convention; no overlap with
   other open work.
4. **Draft PR only** — no merge, no commissioning, no deployment, and no allowlist
   population on a real target without explicit, separate owner authorisation.
5. **Supervised egress mediator is a commissioning prerequisite** — the strict
   one-active-check, freshness, deadline, and policy-activation guarantees (R1/R2/R3)
   are enforceable only because the effect is emitted through a mediator the
   suspendable worker cannot bypass: it runs the final connect-time check, owns and
   deadline-bounds the socket, and signals its closure (the termination proof). Until
   this mediator exists **no effect may be emitted** — the capability fails closed —
   and commissioning must not proceed. The concurrency, freshness, and policy-change
   limits are preserved strictly — **not** relaxed; any future relaxation is a
   separate, explicit owner decision.
