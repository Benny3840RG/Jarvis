# #779 `security:tcp-check` — commissioning specifications (planning only)

**Status: planning document for the scope the owner locked on #779 (2026-11-09).
It proposes the three concrete mechanisms (WS-A enforcer, WS-B durable store, WS-C
time) and writes the WS-D adversarial matrix. It changes no code, opens no socket,
populates no allowlist, and moves no registry entry. `security:tcp-check` stays
`planned` and default-deny. Every workstream still needs separate owner approval
before any code, and WS-E stays owner-only.**

Read with `docs/design/issue-732-stage3-authorised-diagnostics.md` (the Stage-1
design) and `docs/evidence/am-016-tcp-check-planning.md` (what PR #780 delivered).
Where this document says "today", it means `main` at `4c055bba`.

Every mechanism below is a **proposal**. Items marked **VERIFY** are host or kernel
behaviours this document relies on but has not observed; each is a named case in the
WS-D matrix and must be demonstrated before the spec is treated as true.

## What exists today, and what does not

PR #780 delivered the decision logic as pure reducers behind injected ports. The
relevant facts for this tranche:

| Port / rule                         | Where                                                             | What it proves today                                                                                   | What it cannot prove                                                 |
| ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `EgressEnforcer` / `BrokerEnforcer` | `typescript/src/security/tcpCheck/enforcer.ts`                    | Order of checks: ledger begin, abort, fence, gate from a fresh clock and policy read, abort, connect   | That a socket was or was not opened; it runs in the caller's process |
| `Connector`                         | `enforcer.ts`, `tcpCheckProvider.ts` (`notCommissionedConnector`) | The default connector refuses                                                                          | Anything about a real connect                                        |
| `LedgerPort` + reducer              | `singleUseLedger.ts`                                              | absent → `consuming` → `settled`; replay never returns `fresh`                                         | Atomicity or durability: the only store is in memory                 |
| `FenceChecker`                      | `enforcer.ts`                                                     | A superseded token is refused when the check runs                                                      | That the token is still live when the syscall runs                   |
| Admission reducer                   | `admission.ts`                                                    | One slot per owner; never-refunded 60 s history; `uncertain` holds the slot; only a signal resolves it | That the signal reflects a real socket                               |
| Gate                                | `gate.ts`                                                         | Table anchor, expiry, epoch, digest, target, freshness                                                 | That the clock it was given is trustworthy                           |

So obligations 1–5 hold **in the reducers**. None holds at a real boundary yet,
because no real boundary exists. The three specifications below supply one each.

## WS-A — Egress enforcer (obligations 1 and 3)

### A1. Who owns the socket

A dedicated **broker process**, run as its own operating-system user (working name
`jarvis-egress`), is the only component that contains a real `Connector`. The Jarvis
service process (the "worker") keeps `notCommissionedConnector` and never gains a
real one. The worker reaches the broker over a Unix domain socket in a directory only
the two users can enter; the broker checks the peer's user id on every connection and
refuses any other caller.

The worker sends the claim and nothing else. It cannot pass a file descriptor, an
address override, a deadline override or a pre-opened socket. The broker rebuilds
the target from the claim, re-runs the full gate itself, and opens the socket itself.

### A2. What stops a connect around the broker

Two layers. The second is the enforcement point of record; the first is not.

1. **In the repository.** No file under `typescript/src/security/tcpCheck/` imports
   `node:net`, `node:tls`, `node:dgram`, `node:http` or `node:child_process` outside
   the broker's own entry point. That holds today by inspection only; no test
   asserts it. The implementation PR adds an import-boundary test for the list
   above.
2. **In the kernel.** An nftables output rule set owned by root:
   - a set `tcpcheck_live` of `(destination address, destination port)` pairs, each
     element carrying a **kernel timeout**;
   - for the `jarvis-egress` user: accept a new TCP connection only if the pair is
     in `tcpcheck_live`; reject everything else, including all UDP and all other
     destinations. The broker therefore has no general network access;
   - for **every other user** on the host: reject new TCP connections to any pair in
     the reviewed allowlist. A worker that tries to connect directly to an
     allowlisted target is refused by the kernel, whatever its code does.

**Scope of the claim, stated plainly.** This prevents any process other than the
broker from reaching an **allowlisted** target, and prevents the broker from reaching
anything that is not currently live. It does **not** stop the Jarvis service from
opening sockets to unrelated addresses: that process already has general outbound
access for Convex and Microsoft Graph, and removing it is a separate hardening
decision (see Owner decisions, item 2). The `tcp-check` capability itself can reach
only what the kernel set admits.

### A3. The deny path that works when the control plane cannot publish

The independent deny path is the **element timeout in the kernel set**. Nothing in
userspace has to succeed for it to take effect.

- A root-owned **renewer** adds or refreshes an element only while all of these hold:
  the pair is in the active reviewed allowlist, the special-use table matches its
  anchor, the table is within its freshness bound, and the durable store reports no
  pending narrowing for that pair.
- Each refresh sets the element timeout to `T_live` (proposal: **30 s**), and the
  renewer refreshes every `T_live / 3`.
- If the renewer crashes, hangs, loses the store, or cannot decide, it stops
  refreshing. The elements then expire in the kernel and the broker's connects are
  rejected. "Set the policy to deny" is therefore the **absence** of an action, which
  cannot fail.

### A4. Ordering of activation and expiry

- **Narrowing (remove a target, or freshness lapses):**
  1. record the pending narrowing durably (the renewer stops refreshing that pair);
  2. delete the element from the kernel set;
  3. read the kernel set back and confirm the pair is absent;
  4. only then advance the policy epoch and activate the new policy.
     If step 2 or 3 fails, try flushing the whole set. If that also fails, wait `T_live`
     from the last successful refresh and read back again. Activation never precedes a
     confirmed absence.
- **Widening (add a target):** activate the policy in the store first, then add the
  element. The kernel never admits a pair the active policy does not contain.

**Maximum supported teardown delay.** With a working control plane: the time of one
nftables transaction plus readback (to be measured in WS-D; expected well under one
second). With a failed control plane: `T_live` after the last successful refresh.
This is a **requirement to demonstrate**, not a result.

### A5. Failure assumptions (named)

- The kernel and nftables enforce the rule set as written, and root is not
  compromised.
- No other process runs as `jarvis-egress`, and that user has no shell or sudo.
- Element timeouts run on the kernel's own timer, not the wall clock, so a wall-clock
  step does not extend them. **VERIFY** (D14).
- Across a host suspend, kernel timers may not advance. A resume hook flushes
  `tcpcheck_live` before the broker is allowed to run. **VERIFY** (D15).
- The rule set is loaded before the broker starts and the broker refuses to start if
  it cannot read back the expected rules. A boot with no rule set means no broker.

### A6. Superseded capabilities at the effect boundary (obligation 3)

The fence check alone cannot be atomic with the syscall; a broker can pause between
them. The design does not rely on that atomicity. It relies on three facts:

- The right to connect is granted by **one durable transition** (WS-B, B1) that also
  re-checks the fence inside the same transaction. A superseded fence cannot obtain
  that grant.
- Recovery may release a stale `reserved` only by superseding its fence in the store.
  After that, the old capability can never obtain the grant, so it can never reach
  the connect call.
- Once the grant exists, recovery can no longer treat the attempt as `reserved`. It
  becomes `uncertain` and holds the slot until the broker supplies evidence (B3). A
  paused broker that resumes is still the single executor for that owner, but it
  cannot connect on a stale grant: the `connecting` transition re-checks the fence,
  the policy and the expiry (B1a), and the kernel set must still contain the pair.

**Decisive test (locked on #779):** a paused worker holding an old capability cannot
resume and open a socket after the policy narrows. It is refused three ways: the
grant transaction rejects the superseded epoch, the broker's gate rejects the digest,
and the kernel set no longer contains the pair. D1–D3 require the refusal to be
observed at the kernel counter, not inferred from the broker's reply.

## WS-B — Durable store (obligations 2 and 4)

### B1. The transition that grants the sole right to connect

One Convex mutation, `grantConnect`, keyed on the claim key
(`computeClaimKey`: owner, project, action fingerprint, address, port). In a single
transaction it:

1. looks the claim key up by a unique index;
2. if a row exists, returns it unchanged (never `fresh`);
3. otherwise checks that the owner's admission record is `started` under the
   presented fence token, that the stored claim binding equals the presented one,
   that the policy epoch and digest match the active policy, and that the capability
   has not expired **by the store's clock**;
4. if every check passes, inserts the row in phase `granted`; if one fails, inserts
   the row already settled as `refused` with the typed reason, so the same claim can
   never be presented again (this is what the reducer path does today).

Only the caller that receives a freshly inserted `granted` row may proceed. The mutation is
callable only with the broker's credential, so the worker cannot grant itself.

### B1a. The `connecting` transition re-checks the grant

A grant is not a standing right to connect. A broker can be paused, descheduled or
slow between `granted` and the connect call, so the expiry is checked again at the
last durable step before the socket, and the remaining gap is bounded on the broker's
own clock.

`markConnecting` is one Convex mutation, callable only with the broker's credential.
In a single transaction it:

1. loads the row and requires phase `granted`, written by the calling instance;
2. re-checks, **by the store's clock**, that `now < expiresAtMs`, that the fence
   token is still current, and that the policy epoch and digest still match the
   active policy;
3. if every check passes, moves the row to `connecting`; if one fails, settles the
   row as `refused` with the typed reason (`expired`, `fence_superseded` or
   `policy_changed`) and signals `never-admitted`. No connect call is made.

Between that commit and the syscall the broker applies a monotonic bound,
`T_call` (proposal: **1 000 ms**):

- it reads its monotonic clock immediately **before** sending `markConnecting`;
- it reads it again immediately before the connect call, after the commit returned;
- if more than `T_call` has elapsed, it makes no connect call. The same instance,
  which knows it opened no socket, commits `settled(refused)` with reason `expired`.
  A process pause advances the monotonic clock, so a paused broker fails this check
  when it resumes. A host suspend is covered separately: the resume hook flushes the
  kernel set before the broker runs (A5).

**What expiry therefore bounds.** `expiresAtMs` bounds the **start** of the connect,
not its end: no connect call starts later than `expiresAtMs + T_call` by more than
the residual described below. The connect itself may then run for up to its own
5 000 ms deadline (C1).

**Residual, stated rather than hidden.** No userspace check is atomic with the
syscall. A pause that lands exactly between the second monotonic read and the
connect call is not caught by `T_call`. In that window the grant is still single-use
and still held by the single executor, and the kernel set still decides: a pair
narrowed or left unrefreshed meanwhile is rejected by the kernel (D3, D4). What the
residual can permit is a connect to a **still-allowed** pair later than
`expiresAtMs + T_call`. Whether that is acceptable, or whether the lease must also be
enforced in the kernel (a per-grant element with its own timeout), is owner
decision 7.

Proposed phases, extending today's two (`consuming`, `settled`):

| Phase              | Written                                                                            | Meaning                                              |
| ------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `granted`          | by `grantConnect`                                                                  | The sole right exists; no connect call has been made |
| `connecting`       | by `markConnecting` (B1a), **durably, immediately before the connect call**        | A socket may exist                                   |
| `settled(outcome)` | by the broker after the socket is destroyed, or after it declined to connect (B1a) | Outcome observed and recorded                        |
| `retired-unknown`  | by broker recovery (B3)                                                            | Effect ended; outcome can never be known             |

Today's `consuming` maps to `granted` plus `connecting`. Splitting it is what lets
recovery tell "provably no socket" from "a socket may have existed".

### B2. What a retry returns

| Stored state when the retry arrives  | Returned                                                             | New connect? |
| ------------------------------------ | -------------------------------------------------------------------- | ------------ |
| no row, checks pass                  | fresh grant                                                          | yes, once    |
| no row, a check fails                | the typed rejection; `refused` is settled so later retries replay it | no           |
| `granted` or `connecting`            | `effect_uncertain`                                                   | no           |
| `settled(outcome)`                   | `replayed` with the stored outcome                                   | no           |
| `retired-unknown`                    | `effect_uncertain`, permanently                                      | no           |
| store unreachable or the call throws | `effect_uncertain`; slot and barrier retained; reported blocked      | no           |

This covers duplicate delivery, a lost response, a broker restart and a delayed
replay. A new check always needs a new stage and a new approval.

### B3. The evidence that releases an `uncertain` slot

Only these durable records release the slot or clear a narrowing barrier:

1. **`settled(outcome)`** — the broker saw the socket end and recorded it. Signal:
   `socket-closed`, with a known outcome. Where the row was refused at or after
   `markConnecting` without any connect call (B1a), the signal is `never-admitted`.
2. **Proven never connected** — the row is `granted` (no `connecting` record), **and**
   the broker instance that held the grant is proven dead. The `connecting` record
   precedes the connect call, so its absence proves no socket was opened. Recovery
   settles the row as `refused` and signals `never-admitted`.
3. **Proven ended, outcome unknown** — the row is `connecting`, **and** the broker
   instance that held it is proven dead. The kernel closes a dead process's sockets,
   so the effect is over, but nobody observed the result. Recovery writes
   `retired-unknown` and signals `socket-closed`. The slot is released; the answer to
   the caller stays `effect_uncertain` forever.

Case 3 is where "network outcome unknown" and "effect proven quiescent" stay
separate: liveness is resolved without inventing a network result.

**Proof that a broker instance is dead.** Each broker start takes an exclusive
operating-system lock and registers a new instance id in the store; every row records
the instance id that wrote it. A row's holder is proven dead only when a **newer
instance holds the lock**. The lock is released by the kernel when the old process
exits, so a paused old broker still holds it and a new one cannot start.

**Elapsed time alone never releases anything.** If the store is unreachable, the
broker cannot start, or the lock cannot be taken, the slot and barrier stay held and
the attempt is reported blocked. This is the eventual-resolution guarantee, stated
under its assumptions: _the host eventually runs a broker that can take the lock and
reach the store._ There is no fixed time bound.

### B4. Retirement

Ledger rows are never deleted, reopened or expired. A claim key that has ever been
granted is retired for good. Row growth is bounded by the rate limit (at most ten
per owner per minute). Whether to archive very old rows is an owner decision; until
decided, keep them all.

## WS-C — Time (obligation 5)

### C1. Which clock decides what

| Decision                          | Clock                                                                                                      | Starts / compared against                                                                        | On restart or loss of trust                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Capability expiry (`expiresAtMs`) | **Store** time, inside `grantConnect` and again inside `markConnecting` (B1a)                              | Set by the store at `reserved → started`: start time + 15 000 ms lease                           | Issued and checked by the same clock, so no cross-process skew. A row carries its own expiry; restart changes nothing |
| Grant-to-connect gap (`T_call`)   | **Broker monotonic** clock                                                                                 | Read before `markConnecting` is sent; compared immediately before the connect call               | Lost with the process; a new instance never connects on an old row (B3)                                               |
| Connect deadline (5 000 ms)       | **Broker monotonic** clock                                                                                 | Starts when the broker makes the connect call, immediately after the durable `connecting` record | Lost with the process; the attempt becomes case 3 in B3, never a `timed-out`                                          |
| Rate window                       | **Store** time                                                                                             | The `startedAtMs` written at `reserved → started`                                                | History is durable. If store time is earlier than the newest record, refuse (`rate_limited`) until it is later        |
| Table freshness                   | Store time at reservation and grant; broker wall clock at its gate; renewer wall clock before each refresh | Snapshot date read from the anchor-verified table                                                | Any party that cannot trust its clock denies. The renewer then stops refreshing, so the kernel denies too             |
| Kernel element lifetime           | Kernel timer                                                                                               | Last successful refresh                                                                          | Flushed on boot and on resume                                                                                         |

**Clock trust rule for the broker and renewer.** At start, and before each decision,
the wall clock must be no earlier than the table's snapshot date and no earlier than
the newest timestamp already recorded in the store. If either fails, deny everything
and report blocked. A clock that runs fast only causes early denial, which is safe.

### C2. Rate limiter

- Window: **60 000 ms**, rolling. A started record counts while
  `startedAtMs > now − 60 000`. A record exactly 60 000 ms old no longer counts.
  This is the comparison already in `admission.ts` (`startsInWindow`).
- Cap: a reservation is refused when the count is **10 or more**.
- A record is written at `reserved → started` and is never refunded, whatever
  follows.
- A record with a timestamp later than `now` counts (fail closed).

### C3. Port range

Integer **1–65535** inclusive (`MIN_PORT`, `MAX_PORT` in `allowlist.ts`). Port 0,
negative, fractional, non-numeric and string forms are rejected at the tool schema,
at claim validation, in `grantConnect` and in the broker. The kernel set holds only
ports that passed all four.

### C4. A recorded timeout versus an unknown effect

`timed-out` may be recorded only when **all** of these are true, in this order:

1. a durable `connecting` record exists;
2. the same broker instance saw its own deadline timer fire;
3. it destroyed the socket;
4. it committed `settled(timed-out)`.

Anything short of that is `effect_uncertain`: the broker died, the commit failed,
the store was unreachable, or the reply to the worker was lost. A worker-side timer
expiring while waiting for the broker is **not** a timeout result; it is reported
blocked and the stored status is read on retry.

## WS-D — Adversarial matrix

Written now, as the locked scope requires. **It is run only after WS-A to WS-C have
landed and the evidence run has separate owner authorisation.**

**Observations required for every case.** A reducer or broker reply alone never
passes a case. Each needs both:

- **Egress boundary:** the kernel rule counters for the accept and reject rules, read
  before and after, plus a packet capture on the test interface showing the number
  of **connection attempts** to the target;
- **Durable store:** the ledger row and the owner's admission record, read back after
  the case.

**How attempts are counted.** In the table, "n SYN" means n connection attempts. An
attempt is identified by its source port and initial sequence number. The kernel
retransmits an unanswered SYN, so one attempt can put several SYN packets on the
wire; retransmissions carrying the same source port and sequence number belong to
the same attempt and are not counted again. A SYN with a new source port or sequence
number is a new attempt.

**Proposed test target.** A listener inside a private network namespace on the same
host, reached over a virtual link, so no packet leaves the machine. Its address must
not be in the special-use table or the gate will refuse it; choosing and reviewing
that synthetic address is an owner decision (item 3). No real third-party target is
used anywhere in this matrix.

| #   | Case                                                                                                     | Obl.    | Expected at the egress boundary                                                      | Expected in the store                                                                  |
| --- | -------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| D1  | Worker paused before `reserved → started`; recovery supersedes its fence; policy narrows; worker resumes | 1, 3    | 0 SYN; no accept count                                                               | No ledger row; attempt released by fenced cleanup                                      |
| D2  | Worker paused after `started`, before sending the claim; target removed; worker resumes                  | 1, 3    | 0 SYN; pair absent from the kernel set                                               | `refused` settled with `policy_changed`; `never-admitted`                              |
| D3  | Broker paused between its gate and the connect call; target removed and confirmed absent; broker resumes | 1       | Connect rejected by the kernel; reject counter +1; 0 SYN on the wire                 | `connecting`, then `settled(error)`; slot released on that record                      |
| D4  | Control plane killed while a target is live; nothing publishes a deny                                    | 1       | After `T_live`, connect rejected; reject counter +1                                  | Attempt refused or settled `error`; never `connected`                                  |
| D5  | Narrowing where element deletion fails                                                                   | 1       | Pair still present until flush or expiry                                             | Epoch **not** advanced until readback shows absence                                    |
| D6  | Freshness bound passes while a reservation is held                                                       | 1, 5    | 0 SYN; element not refreshed                                                         | `refused`, `policy_changed`                                                            |
| D7  | Capability expires before the grant                                                                      | 5       | 0 SYN                                                                                | `refused`, `expired`                                                                   |
| D8  | Same claim delivered twice at once                                                                       | 2       | Exactly 1 SYN                                                                        | One row; second caller gets `effect_uncertain` or `replayed`                           |
| D9  | Response lost after `settled`; worker retries                                                            | 2       | No further SYN                                                                       | `replayed` with the stored outcome                                                     |
| D10 | Broker killed after `granted`, before `connecting`; new broker starts                                    | 2, 3, 4 | 0 SYN                                                                                | Row settled `refused`; `never-admitted`; slot released                                 |
| D11 | Broker killed after `connecting`, socket open; new broker starts                                         | 2, 3, 4 | 1 SYN total; no reconnect                                                            | `retired-unknown`; slot released; caller sees `effect_uncertain`                       |
| D12 | As D11, but the old broker is only paused (not dead)                                                     | 3, 4    | No second SYN                                                                        | New broker cannot take the lock; slot **held**; reported blocked however long it lasts |
| D13 | Store unreachable during finalize                                                                        | 4       | 1 SYN                                                                                | Row stays `connecting`; slot held; blocked; resolves only once the store returns       |
| D14 | Wall clock stepped forward and back while an element is live                                             | 5       | Element lifetime unchanged                                                           | Clock-trust rule denies when time is earlier than the newest record                    |
| D15 | Host suspended with a live element, then resumed                                                         | 1, 5    | Set flushed before the broker runs; 0 SYN to the old pair                            | No grant issued until the renewer re-adds the pair                                     |
| D16 | Eleven starts in 60 s, then one more at exactly 60 000 ms after the first                                | 5       | 10 SYN, then 1 more                                                                  | Eleventh refused `rate_limited`; the later one admitted                                |
| D17 | Deadline fires on a silent target                                                                        | 5       | 1 attempt; its retransmissions allowed until 5 s; none after the socket is destroyed | `settled(timed-out)` written by the same instance                                      |
| D18 | Worker's own wait expires while the broker is still connecting                                           | 5       | 1 SYN                                                                                | Worker reports blocked; store later shows the real outcome                             |
| D19 | Worker process connects directly to an allowlisted target                                                | 1       | Rejected by the kernel; reject counter +1; 0 SYN                                     | No ledger row                                                                          |
| D20 | Straggler worker tries to commit a result after recovery marked the attempt `uncertain`                  | 3       | No SYN                                                                               | Commit refused on the superseded fence; state unchanged                                |
| D21 | Port 0, 65536, `"80"`, 80.5                                                                              | 5       | 0 SYN                                                                                | Rejected before any reservation; no history entry                                      |
| D22 | Broker started with no rule set loaded                                                                   | 1       | 0 SYN                                                                                | Broker refuses to start; all attempts blocked                                          |
| D23 | Broker paused after `granted` until past `expiresAtMs`, pair still allowed; broker resumes               | 3, 5    | 0 SYN; no accept count                                                               | `markConnecting` refuses; `refused`, `expired`; `never-admitted`; slot released        |
| D24 | Broker paused after the `connecting` commit for longer than `T_call`, pair still allowed; broker resumes | 3, 5    | 0 SYN; no accept count                                                               | `settled(refused)`, `expired`, written by the same instance; slot released             |

A case passes only if both columns are observed. Any `connected` that the packet
capture does not support, or any SYN the store cannot account for, fails the run.

## WS-E — Registry promotion

Not specified here. It stays owner-only, behind passing WS-A to WS-D evidence and
explicit sign-off.

## Obligation coverage

| Obligation (#779)                                               | Specified in | Demonstrated by                |
| --------------------------------------------------------------- | ------------ | ------------------------------ |
| 1 — freshness and revocation timing, independent deny path      | A2–A5        | D1–D6, D15, D19, D22           |
| 2 — durable single use at the egress boundary                   | B1, B2, B4   | D8–D11                         |
| 3 — effect boundary rejects superseded capabilities             | A6, B1a, B3  | D1–D3, D10–D12, D20, D23, D24  |
| 4 — eventual resolution under named assumptions                 | B3           | D10–D13                        |
| 5 — deadline origin, timeout versus unknown, port range, window | B1a, C1–C4   | D6, D7, D14–D18, D21, D23, D24 |

No obligation box on #779 should be ticked from this document. Each is ticked only
when implemented and covered by its matrix cases.

## Owner decisions needed

1. **Approve, amend or reject each of WS-A, WS-B and WS-C as the specification to
   build.** Each is a separate approval.
2. **Worker egress scope.** Accept the stated scope (the kernel blocks direct
   connects to allowlisted targets only), or require default-deny outbound for the
   Jarvis service with explicit exceptions for its existing providers. The second is
   stronger and considerably more work.
3. **Synthetic test target.** Approve a host-local address for the WS-D run that is
   outside the special-use table and never routed off the machine.
4. **`T_live`.** Confirm 30 s as the worst-case teardown delay when the control
   plane has failed, or set another value.
5. **Root-owned components.** The rule set, the renewer and the resume hook need
   root on the host. Confirm that is acceptable for a development-only capability.
6. **Ledger retention.** Keep every row indefinitely, or define an archive rule.
7. **Lease enforcement at the syscall.** Accept the residual in B1a (a pause between
   the last broker check and the connect call can start a connect to a still-allowed
   pair after `expiresAtMs + T_call`), or require the lease to be enforced in the
   kernel as well. Also confirm `T_call` at 1 000 ms or set another value.

## Gates

- Planning only. No implementation, target check, allowlist entry, merge or
  deployment is authorised by this document.
- The broker, the rule set and the store mutations are each written only after the
  owner approves the corresponding workstream.
- The WS-D run needs its own authorisation after WS-A to WS-C land.
- AM-016 and `TOOL-SECURITY-TCP-CHECK` stay `planned`.
