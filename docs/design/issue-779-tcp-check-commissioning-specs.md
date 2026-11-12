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

The reducers model parts of the decision logic only. **None of obligations 1–5 is
established today**: there is no real connector and no kernel gate, the ledger is an
in-memory reducer, the production provider wiring returns `null`, and no clock is
trusted. Each obligation stays unestablished until the boundary specified below
exists and its matrix cases have been observed.

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
   - a second set `tcpcheck_guarded`, with **no** timeouts, holding every pair that
     is or has ever been in a reviewed allowlist. Pairs are only ever added to it;
   - for **every other user** on the host: reject **every** TCP packet to any pair
     in `tcpcheck_guarded`, whatever the connection state. A worker that tries to
     connect directly to a target is refused by the kernel whatever its code does,
     **both while the target is allowlisted and after it has been removed**. Because
     the rule is not limited to new connections, a connection some other process had
     already opened to that pair before the pair was guarded stops passing traffic
     as soon as the pair is added.

`tcpcheck_guarded` is the durable record of what the capability has ever been
allowed to reach. Its contents are kept in a root-owned file loaded with the rule
set, and mirrored in the store. Before the policy that first contains a pair is
activated (A4), four things must have happened in this order: the pair is added to
the store's historical-pair list, which is append-only, and read back from the
store; the pair is written to the root-owned file and the file and its directory
are synced to disk; the pair is added to the kernel set; the kernel set is read back
and contains it. If any of the four fails, the policy is not activated. The store
is written first so that it is never behind the file: a crash at any later point
leaves a store that already lists the pair, and the guard unit below then refuses
a file or kernel set that lacks it. The broker
refuses to start unless the kernel set contains every pair the store lists.

**The worker does not run without the guard.** The worker has general outbound
access, so a boot with no rule set, or with an older guarded set, would leave former
targets reachable. The Jarvis service unit is therefore ordered after, and requires,
a root-owned unit that loads the rule set and then compares three things: the
historical pairs listed in the durable store, the root-owned file, and the kernel
set read back. It succeeds only if the file and the kernel set each contain every
pair the store lists. A file restored to an older version, a store it cannot reach,
or any difference makes the unit fail, and the Jarvis service then does not start.
This couples the service's startup to the rule set **and to the store being
reachable at boot**, and is part of owner decision 5. Removing a pair from it
is never automatic; it is a separate owner action.

**Scope of the claim, stated plainly.** This prevents any process other than the
broker from reaching a target that is or ever was allowlisted, and prevents the
broker from reaching anything that is not currently live. It does **not** stop the Jarvis service from
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
- Each refresh gives the element a full `T_live` (proposal: **30 s**) again, and the
  renewer refreshes every `T_live / 3`.
- **How a refresh is done.** The timeout of an existing nftables set element cannot
  be relied on to change by adding the element again; the element has to be
  recreated. A refresh is therefore one atomic nftables transaction (a single
  `nft -f` batch): `add element` when the readback shows the pair absent; `delete
element` followed by `add element … timeout T_live` when it is present. The
  renewer then reads the set back and requires the element's remaining lifetime to
  be close to `T_live`. If the readback does not show that, it stops refreshing and
  reports blocked. That a delete-and-add in one batch leaves no moment in which the
  pair is absent, and that it resets the lifetime on the target kernel, is
  **VERIFY** (D38).
- **Kernel updates are serialised with narrowing.** The renewer and the narrowing
  procedure (A4) both take one root-only host lock, `tcpcheck_ctl`, pinned to a
  single inode in the same way as the broker's lock (B3). The renewer holds it from
  before its store read until after its readback. A pending narrowing is committed
  to the store **only while holding that lock**, by the root control-plane
  component, and the lock is kept through the kernel deletion and readback. A
  refresh therefore either finishes before the narrowing commits, and is then
  deleted by it, or starts after and sees the pending narrowing.
- **The lock covers whatever actually submits the update.** If the renewer submits
  the batch itself, in process, its own descriptor is enough. If it runs a separate
  `nft` process, that process **inherits the lock descriptor** (it is deliberately
  not close-on-exec here, unlike the broker's lock), so the lock stays held until
  the updater has exited, even if the renewer that started it is dead. The renewer
  and any updater it starts run in one control group.
- **Holding the lock is the only proof.** The narrowing procedure commits nothing
  until it holds `tcpcheck_ctl` itself. If it cannot take the lock within `T_ctl`
  (proposal: **2 000 ms**), the control plane kills the renewer's whole control
  group and keeps waiting for the lock. Killing is not treated as proof that no
  update is in flight: only acquiring the lock is, because it cannot be acquired
  while any updater still holds the descriptor. If the lock is never acquired, the
  narrowing stays blocked and is reported so. Meanwhile nothing can refresh either,
  so the element only ages and is gone within `T_live` of its last refresh.
- If the renewer crashes, hangs, loses the store, or cannot decide, it stops
  refreshing. The elements then expire in the kernel and the broker's connects are
  rejected. "Set the policy to deny" is therefore the **absence** of an action, which
  cannot fail.

### A4. Ordering of activation and expiry

- **Narrowing (remove a target, or freshness lapses):**
  1. take `tcpcheck_ctl` (A3) and record the pending narrowing durably. The lock is
     held through step 3. From this commit on, the renewer stops
     refreshing that pair, `grantConnect` and `markConnecting` refuse it with
     `policy_changed` (B1, B1a), and the broker's own gate refuses it. The old policy
     is still the active one, but it can no longer authorise a new connect to that
     pair;
  2. delete the element from the kernel set;
  3. read the kernel set back and confirm the pair is absent;
  4. wait until no ledger row for that pair is `granted` or `connecting` (B3 evidence
     only, never elapsed time);
  5. only then advance the policy epoch and activate the new policy.
     If step 2 or 3 fails, try flushing the whole set. If that also fails, wait `T_live`
     from the last successful refresh and read back again. Activation never precedes a
     confirmed absence. While deletion is failing (D5) the pair can still be in the
     kernel set, but step 1 already stops every new grant and every new `connecting`
     record for it.
- **Widening (add a target):** record the pair in the store's historical list and
  read it back, persist it in the guarded file, add it to `tcpcheck_guarded` and
  read that back (A2, in that order); then activate the policy in the store; then add the element to `tcpcheck_live`. The
  kernel never admits a pair the active policy does not contain, and no pair becomes
  reachable by the broker before it is denied to everyone else.

**The one connect a narrowing cannot recall.** A row that reached `connecting` before
step 1 committed may still make its connect call within `T_call` (B1a) while the
pair is in the kernel set. That connect was authorised before the narrowing was
recorded. Step 4 keeps the narrowing from being reported as active until that socket
is proven ended.

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
- The rule set is loaded before the broker **and before the worker** start. The
  broker refuses to start if it cannot read back the expected rules, and the Jarvis
  service unit does not start unless the guard unit succeeded (A2). A boot with no
  rule set means no broker and no worker.

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
and the kernel set no longer contains the pair. None of D1–D3 is passed on the
broker's reply alone. D1 and D2 are refused before any connect call, so they require
the accept **and** reject counters to be unchanged, a capture showing no attempt, and
the durable refusal. D3 is the case that reaches the kernel: it requires the reject
rule's counter to increase by one and no SYN on the wire.

## WS-B — Durable store (obligations 2 and 4)

### B1. The transition that grants the sole right to connect

One Convex mutation, `grantConnect`, keyed on the claim key
(`computeClaimKey`: owner, project, action fingerprint, address, port). In a single
transaction it:

1. reads the claim key through an index, by equality;
2. if a row exists, returns it unchanged (never `fresh`);
3. otherwise checks that the owner's admission record is `started` under the
   presented fence token and that the claim binding stored for that attempt equals
   the presented claim's. (The binding exists today as `ClaimBindingRecord`, keyed by
   attempt id, in `tcpCheckProvider.ts`. Today the provider reserves, then builds
   the claim with `expiresAtMs` taken from its own clock, then writes the binding in
   a separate await, all before `started`; the only store is in memory. WS-B changes
   this as described under "Where the lease starts" below.) If either fails it returns the typed rejection and **inserts nothing**: without a
   matching `started` record no later call can be granted either, so there is
   nothing to retire;
4. then checks that the policy epoch and digest match the active policy, that no
   narrowing is pending for the pair (A4), and that the capability has not expired
   **by the store's clock** (C1);
5. if every check in step 4 passes, inserts the row in phase `granted`; if one fails,
   inserts the row already settled as `refused` with the typed reason, so the same
   claim can never be presented again (the reducer path finalises a rejected claim
   as `refused` today).

**Why there is only ever one row.** Convex indexes do not enforce uniqueness, so the
design does not assume a unique index. It relies on Convex mutations being
serialisable transactions: the indexed read in step 1 and the insert in step 5 are in
the same transaction, so two concurrent calls for one claim key cannot both observe
"no row" and both commit. **VERIFY** (D8): under concurrent delivery the store ends
with exactly one row and exactly one caller received a fresh grant.

**Where the lease starts.** The binding covers `expiresAtMs`
(`computeClaimBinding`), so the expiry must be fixed before the binding is written
and never changed afterwards. WS-B replaces the provider's own clock with one store
mutation, `bindClaim`, called after the reservation and before `started`. In a
single transaction it requires the reservation to be live under the presented fence,
sets `expiresAtMs = now + lease` on the store's clock, computes the binding over the
claim fields including that value, stores the binding **together with the claim
key** (`computeClaimKey` over the same fields), and returns the expiry. The stored
claim key is what lets recovery find or retire an attempt whose claim never reached
the broker; the binding alone is a one-way hash and cannot yield it. The worker
freezes its claim with the returned value; it cannot choose or alter it, because any
other value fails the binding comparison in `grantConnect`. `reserved → started`
does not touch the expiry. The lease therefore runs from `bindClaim`, slightly
earlier than `started`.

**Expiry comparison.** `gate.ts` today treats a capability as valid while
`now ≤ expiresAtMs` and expired when `now > expiresAtMs`. The store mutations keep
that direction but apply the guard margin from C1: `grantConnect` and
`markConnecting` refuse when `now > expiresAtMs − T_guard`.

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
2. re-checks, **by the store's clock**, that `now ≤ expiresAtMs − T_guard` (C1), that the fence
   token is still current, that the policy epoch and digest still match the active
   policy, and that no narrowing is pending for the pair;
3. if every check passes, moves the row to `connecting`; if one fails, settles the
   row as `refused` with the typed reason (`expired`, `fence_superseded` or
   `policy_changed`) and signals `never-admitted`. No connect call is made.

Between that commit and the syscall the broker applies a monotonic bound,
`T_call` (proposal: **1 000 ms**):

- it reads its monotonic clock immediately **before** sending `markConnecting`;
- it reads it again immediately before the connect call, after the commit returned;
- if more than `T_call` has elapsed, it makes no connect call. The same instance,
  which knows it opened no socket, commits `settled(refused)` with reason
  `connect_window_elapsed`. This is a new typed reason, distinct from `expired`: the
  lease may still have seconds left (for example when the store was slow to answer),
  and the two must not be confused in evidence.
  A process pause advances the monotonic clock, so a paused broker fails this check
  when it resumes. A host suspend is covered separately: the resume hook flushes the
  kernel set before the broker runs (A5).

**What this achieves, and what it does not.** With the two checks above, a broker
paused anywhere up to its second monotonic read cannot connect on an expired
capability (D23, D24). The connect itself may then run for up to its own 5 000 ms
deadline (C1); expiry bounds the **start** of a connect, not its end.

No userspace check is atomic with the syscall. A pause that lands exactly between
the second monotonic read and the connect call is not caught by `T_call`. In that
window the grant is still single-use and still held by the single executor, and the
kernel still decides policy: a pair narrowed or left unrefreshed meanwhile is
rejected (D3). But a connect to a **still-allowed** pair could start after
`expiresAtMs`.

**So the #779 requirement that an expired capability is rejected at the egress
boundary is NOT yet specified by this document.** It is blocked on owner decision 7,
which chooses between:

- **7a — enforce the lease in the kernel (recommended).** A root-owned helper adds a
  per-grant accept rule for the pair that carries an **absolute** time bound
  evaluated by the kernel on each packet (nftables `meta time`), and the broker's
  accept rule requires it. A helper that is paused or slow can then only add the rule
  late, which shortens the window and never lengthens it. This needs its own
  specification before it is built: the helper's interface, how the store's expiry
  is mapped onto the kernel's wall clock, and the skew allowance. Whether `meta time`
  behaves this way on the target kernel is **VERIFY**.
- **7b — accept the residual.** The contract is then weaker than #779 states: an
  expired capability is refused at every durable step and at the broker's last
  check, but not at the syscall. That is an amendment to the locked scope and needs
  the owner to say so explicitly.

D27 is the case that separates the two.

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

| Stored state when the retry arrives                                         | Returned                                                                                  | New connect? |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| no row, checks pass                                                         | fresh grant                                                                               | yes, once    |
| no row, no matching `started` admission record (B1 step 3)                  | the typed rejection; no row is written; a retry is evaluated again and fails the same way | no           |
| no row, admission `started` or `uncertain`, claim never granted (B3 case 4) | `retireUngranted` settles `refused`; later retries replay it                              | no           |
| no row, a policy, pending-narrowing or expiry check fails (B1 step 4)       | the typed rejection; `refused` is settled so later retries replay it                      | no           |
| `granted` or `connecting`                                                   | `effect_uncertain`                                                                        | no           |
| `settled(outcome)`                                                          | `replayed` with the stored outcome                                                        | no           |
| `retired-unknown`                                                           | `effect_uncertain`, permanently                                                           | no           |
| store unreachable or the call throws                                        | `effect_uncertain`; slot and barrier retained; reported blocked                           | no           |

This covers duplicate delivery, a lost response, a broker restart and a delayed
replay. A new check always needs a new stage and a new approval. That later
check is not blocked by the retired key: the claim key includes the action
fingerprint, which `tcpCheckTool.ts` builds from the effect fingerprint **and the
staged action's id**, so each staged action has its own key even for the same
address and port. The implementation must keep that property; D9 checks that a
retry of one action replays, and D34 that a newly staged action for the same target
gets a fresh grant.

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

4. **Never granted** — the admission record is `started` (or `uncertain` after
   recovery) and **no ledger row exists** for its claim key. This happens when the
   worker died before sending the claim, or the broker died or lost the store before
   `grantConnect` committed. No socket can exist without a grant. The broker (the
   running instance, or a new one at start) calls `retireUngranted` with the attempt
   id: one transaction that reads the claim key stored by `bindClaim` (B1), looks
   that key up and, only if there is still no row, inserts it settled
   as `refused` with reason `fence_superseded`, then signals `never-admitted`. If a
   grant committed first, the transaction finds the row and changes nothing, and
   cases 1–3 apply. Serialisability makes this safe without the death proof: a late
   `grantConnect` for the same key finds the refused row and returns it.

A refusal written by `grantConnect` itself (B1 step 5) also signals `never-admitted`.

Case 3 is where "network outcome unknown" and "effect proven quiescent" stay
separate: liveness is resolved without inventing a network result.

**A `connecting` attempt's fence is not superseded.** Today's `recover` moves a
`started` admission to `uncertain` and advances its fence. Nothing checks the fence
after `markConnecting`, so advancing it then would leave a superseded capability
free to connect. The durable recovery mutation therefore reads the ledger row in
the same transaction: if the row is `connecting`, it leaves the admission and its
fence unchanged and reports the slot held. Serialisability orders it against
`markConnecting`: either recovery commits first and `markConnecting` then refuses
with `fence_superseded`, or `markConnecting` commits first and recovery defers. The
attempt is then resolved only by case 1 or case 3 (D36).

**Proof that a broker instance is dead.** Each broker start takes an exclusive
operating-system lock and registers a new instance id in the store; every row records
the instance id that wrote it. A row's holder is proven dead only when a **newer
instance holds the lock**. A paused old broker still holds it, so a new one cannot
start.

The lock is an advisory `flock`, which belongs to the open file description, not to
the process. It is released when every descriptor referring to that description is
closed, so a child or any other process holding an inherited or duplicated
descriptor keeps it locked after the broker dies. The proof therefore also requires:
the lock file is opened close-on-exec; the broker starts no child process and passes
no descriptor to anyone (the import-boundary test in A2 covers `node:child_process`
for the broker's entry point as well).

Every instance must lock the **same inode**, or a newer lock proves nothing: if the
pathname could be replaced, a paused old broker would keep its lock on the old file
while a new one locked the new file. So the lock file is created once by root, in a
directory owned by root that `jarvis-egress` cannot write, rename or unlink in; the
broker opens it read-only (an advisory lock does not need write access). The file's
device and inode numbers are recorded in the store when it is created. After taking
the lock, each instance compares the numbers of its open descriptor, and of the
pathname, with the stored ones and refuses to start on any difference (D30). A surviving descriptor is fail-closed: the new broker
cannot take the lock, the slot stays held and the attempt is reported blocked.
**VERIFY** (D29).

**Elapsed time alone never releases anything.** If the store is unreachable, the
broker cannot start, or the lock cannot be taken, the slot and barrier stay held and
the attempt is reported blocked. This is the eventual-resolution guarantee, stated
under its assumptions: _the host eventually runs a broker that can take the lock
(no surviving descriptor holds it) and reach the store._ There is no fixed time bound.

### B4. Retirement

Ledger rows are never deleted, reopened or expired. A claim key that has ever been
granted is retired for good. `grantConnect` inserts a row, granted or refused, only
for a claim whose binding matches a `started` admission record (B1, step 3), and
each attempt has exactly one binding, hence one claim key. Row growth is therefore bounded by the number of
`started` records, which the rate limit caps at ten per owner per minute. A call that
fails step 3 leaves no row. Whether to archive very old rows is an owner decision; until
decided, keep them all.

## WS-C — Time (obligation 5)

### C1. Which clock decides what

| Decision                          | Clock                                                                                                | Starts / compared against                                                                        | On restart or loss of trust                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Capability expiry (`expiresAtMs`) | **Store** time, inside `grantConnect` and again inside `markConnecting` (B1a)                        | Set by the store in `bindClaim` (B1), before `started`: store time + 15 000 ms lease             | Issued and checked by the same clock, which never runs backwards (see below). A row carries its own expiry; restart changes nothing |
| Grant-to-connect gap (`T_call`)   | **Broker monotonic** clock                                                                           | Read before `markConnecting` is sent; compared immediately before the connect call               | Lost with the process; a new instance never connects on an old row (B3)                                                             |
| Connect deadline (5 000 ms)       | **Broker monotonic** clock                                                                           | Starts when the broker makes the connect call, immediately after the durable `connecting` record | Lost with the process; the attempt becomes case 3 in B3, never a `timed-out`                                                        |
| Rate window                       | **Store** time                                                                                       | The `startedAtMs` written at `reserved → started`                                                | History is durable. Store time cannot fall below the newest record, because the high-water mark is at least that value              |
| Table freshness                   | Store time (high-water protected) at reservation, grant, `markConnecting` and each renewer heartbeat | Snapshot date read from the anchor-verified table                                                | A party that cannot reach the store denies. The renewer then stops refreshing, so the kernel denies too                             |
| Kernel element lifetime           | Kernel timer                                                                                         | Last successful refresh                                                                          | Flushed on boot and on resume                                                                                                       |

**One authoritative time: the store's, with a high-water mark.** Every decision
that depends on time (expiry, rate window, freshness) is made on **store time**, and
store time is never allowed to go backwards:

- the store keeps one durable value, `timeHighWaterMs`. Every mutation in this
  design computes `now = max(server time, timeHighWaterMs)` and writes `now` back.
  A server clock that steps back therefore cannot make an expired lease live again
  or a stale table fresh again: decisions continue from the high-water mark. Time
  then appears frozen until the real clock passes the mark, which only denies;
- the renewer writes a heartbeat mutation on every cycle (`T_live / 3`), which keeps
  the high-water mark moving while the capability is in use;
- the high-water mark only records times a mutation actually saw. A backward step
  that happens **between** two mutations is invisible to it: the clock can pass a
  cutoff and step back below it before anything is written. Every cutoff is
  therefore compared with a guard margin, `T_guard` (proposal: **2 000 ms**): a
  capability is treated as expired when `now > expiresAtMs − T_guard`, and a table as
  stale `T_guard` before its bound. This shortens the usable lease by `T_guard` and
  makes the decision correct for any unseen backward step of up to `T_guard`;
- the broker and the renewer do **not** decide freshness or expiry on their own wall
  clocks. Each obtains `now` from the store with the decision it is making (the
  renewer from its heartbeat, the broker from `grantConnect` / `markConnecting`) and
  denies if the store is unreachable. Their local clocks are used only for
  monotonic intervals (`T_call`, the connect deadline, the refresh period);
- as an additional tripwire, if a component's wall clock differs from the store's
  `now` by more than a reviewed tolerance (proposal: **5 000 ms**), it denies and
  reports blocked. This detects a wrong host clock; it never grants anything.

**Named assumptions.** That a Convex mutation reads server time, not the caller's
(**VERIFY**); that the store's clock is not behind true time by more than the
freshness bound can tolerate; and that the store's clock never steps backwards by
more than `T_guard` without a mutation having observed the later time. **The
exact-expiry guarantee is proved only under that last assumption.** A larger unseen
step is outside what this design can detect, because nothing in it has a second
trusted time source; whether that is acceptable is owner decision 8. If the high-water mark is ever pushed far into the
future by a bad clock, everything is denied until an owner resets it; there is no
automatic recovery, by design.

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

Anything short of that is `effect_uncertain`: the broker died, the commit failed, or
the store was unreachable. `effect_uncertain` is reserved for an absent or
untrusted durable result.

A lost reply is different. If `settled(timed-out)` committed and only the reply to
the worker was lost, the outcome is known: the caller lacks the answer for a moment,
and a retry replays the committed `timed-out` (B2, D9). Likewise a worker-side timer
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

| #   | Case                                                                                                     | Obl.    | Expected at the egress boundary                                                                                                          | Expected in the store                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Worker paused before `reserved → started`; recovery supersedes its fence; policy narrows; worker resumes | 1, 3    | 0 SYN; no accept count                                                                                                                   | No ledger row; attempt released by fenced cleanup                                                                                                |
| D2  | Worker paused after `started`, before sending the claim; target removed; worker resumes                  | 1, 3    | 0 SYN; pair absent from the kernel set                                                                                                   | `refused` settled with `policy_changed`; `never-admitted`                                                                                        |
| D3  | Broker paused between its gate and the connect call; target removed and confirmed absent; broker resumes | 1       | Connect rejected by the kernel; reject counter +1; 0 SYN on the wire                                                                     | `connecting`, then `settled(error)`; slot released on that record                                                                                |
| D4  | Control plane killed while a target is live; nothing publishes a deny                                    | 1       | Broker path: 0 SYN, counters unchanged. Then a separate probe run as the broker user after `T_live`: connect rejected; reject counter +1 | Attempt blocked or `effect_uncertain`, never `connected`; the probe writes no ledger row                                                         |
| D5  | Narrowing where element deletion fails                                                                   | 1       | Pair still present until flush or expiry                                                                                                 | Epoch **not** advanced until readback shows absence                                                                                              |
| D6  | Freshness bound passes while a reservation is held                                                       | 1, 5    | 0 SYN; element not refreshed                                                                                                             | `refused`, `policy_changed`                                                                                                                      |
| D7  | Capability expires before the grant                                                                      | 5       | 0 SYN                                                                                                                                    | `refused`, `expired`                                                                                                                             |
| D8  | Same claim delivered twice at once                                                                       | 2       | Exactly 1 SYN                                                                                                                            | Exactly one row and exactly one fresh grant; the other caller gets `effect_uncertain` or `replayed`                                              |
| D9  | Response lost after `settled`; worker retries                                                            | 2       | No further SYN                                                                                                                           | `replayed` with the stored outcome                                                                                                               |
| D10 | Broker killed after `granted`, before `connecting`; new broker starts                                    | 2, 3, 4 | 0 SYN                                                                                                                                    | Row settled `refused`; `never-admitted`; slot released                                                                                           |
| D11 | Broker killed after `connecting`, socket open; new broker starts                                         | 2, 3, 4 | 1 SYN total; no reconnect                                                                                                                | `retired-unknown`; slot released; caller sees `effect_uncertain`                                                                                 |
| D12 | As D11, but the old broker is only paused (not dead)                                                     | 3, 4    | No second SYN                                                                                                                            | New broker cannot take the lock; slot **held**; reported blocked however long it lasts                                                           |
| D13 | Store unreachable during finalize                                                                        | 4       | 1 SYN                                                                                                                                    | Row stays `connecting`; slot held; blocked; resolves only once the store returns                                                                 |
| D14 | Wall clock stepped forward and back while an element is live                                             | 5       | Element lifetime unchanged                                                                                                               | Store time continues from `timeHighWaterMs`; no expired lease or stale table becomes valid again                                                 |
| D15 | Host suspended with a live element, then resumed                                                         | 1, 5    | Set flushed before the broker runs; 0 SYN to the old pair                                                                                | No grant issued until the renewer re-adds the pair                                                                                               |
| D16 | Eleven starts in 60 s, then one more at exactly 60 000 ms after the first                                | 5       | 10 SYN, then 1 more                                                                                                                      | Eleventh refused `rate_limited`; the later one admitted                                                                                          |
| D17 | Deadline fires on a silent target                                                                        | 5       | 1 attempt; its retransmissions allowed until 5 s; none after the socket is destroyed                                                     | `settled(timed-out)` written by the same instance                                                                                                |
| D18 | Worker's own wait expires while the broker is still connecting                                           | 5       | 1 SYN                                                                                                                                    | Worker reports blocked; store later shows the real outcome                                                                                       |
| D19 | Worker process connects directly to a currently allowlisted target                                       | 1       | Rejected by the kernel; reject counter +1; 0 SYN                                                                                         | No ledger row                                                                                                                                    |
| D20 | Straggler worker tries to commit a result after recovery marked the attempt `uncertain`                  | 3       | No SYN                                                                                                                                   | Commit refused on the superseded fence; state unchanged                                                                                          |
| D21 | Port 0, 65536, `"80"`, 80.5                                                                              | 5       | 0 SYN                                                                                                                                    | Rejected before any reservation; no history entry                                                                                                |
| D22 | Broker started with no rule set loaded                                                                   | 1       | 0 SYN                                                                                                                                    | Broker refuses to start; all attempts blocked                                                                                                    |
| D23 | Broker paused after `granted` until past `expiresAtMs`, pair still allowed; broker resumes               | 3, 5    | 0 SYN; no accept count                                                                                                                   | `markConnecting` refuses; `refused`, `expired`; `never-admitted`; slot released                                                                  |
| D24 | Broker paused after the `connecting` commit for longer than `T_call`, pair still allowed; broker resumes | 3, 5    | 0 SYN; no accept count                                                                                                                   | `settled(refused)`, `connect_window_elapsed` (not `expired`; the lease is still valid in this case), written by the same instance; slot released |

| D25 | Narrowing recorded as pending, kernel deletion not yet done (or failing); a claim for that pair is presented; separately, a broker holding a `granted` row for it resumes | 1, 3 | 0 SYN; pair may still be in the kernel set; counters unchanged | `grantConnect` and `markConnecting` both refuse; `refused`, `policy_changed`; epoch not advanced |
| D26 | Target removed and the narrowing activated; worker process connects directly to the former target | 1 | Rejected by the kernel through `tcpcheck_guarded`; reject counter +1; 0 SYN | No ledger row |
| D27 | Broker stopped at a test hook after its second monotonic read, held past `expiresAtMs`, pair still allowed; broker resumes | 5 | Under decision 7a: connect rejected by the kernel; reject counter +1; 0 SYN. Under 7b: one late attempt is expected and is recorded as the accepted residual | 7a: `connecting`, then `settled(error)`. 7b: the real outcome is settled |
| D28 | A mutation is committed after a lease expiry (or freshness cutoff) has passed, so `timeHighWaterMs` is beyond it; the store server clock is then stepped back to before the cutoff but later than the newest record | 5 | 0 SYN; element not refreshed | `now` stays at `timeHighWaterMs`; `refused`, `expired` or `policy_changed` |
| D31 | No mutation is committed across the cutoff: the store server clock passes a lease expiry unseen, then steps back by less than `T_guard`; a claim is presented | 5 | 0 SYN | `refused`, `expired`, by the guard margin. A step larger than `T_guard` is outside the named assumption and is not claimed |
| D29 | Broker killed while another process holds a duplicate of its lock descriptor; new broker starts | 4 | No second attempt | New broker cannot take the lock; slot held; blocked until the descriptor closes, then B3 applies |
| D30 | Broker paused while holding the lock; the lock pathname is replaced with a new file (attempted as `jarvis-egress`, then forced as root in the harness); new broker starts | 4 | No second attempt | As `jarvis-egress` the replacement fails. After the forced replacement the new broker sees a different inode from the stored one and refuses to start; slot held; nothing retired |
| D32 | Broker killed after `reserved → started`, before `grantConnect` commits; separately, worker killed before sending the claim; store then recovers | 3, 4 | 0 SYN | In both variants `retireUngranted` finds the claim key stored by `bindClaim` (the broker never received the claim in the second) and settles `refused`, `fence_superseded`; `never-admitted`; slot and barrier released |
| D33 | Host crashes after a widening is activated, then reboots; worker connects directly to the new target; separately, boot with the rule set failing to load | 1 | Reboot: rejected through `tcpcheck_guarded`; reject counter +1; 0 SYN. Failed load: the Jarvis service does not start; 0 SYN | Guarded file already holds the pair; no ledger row |
| D34 | A check is settled; a new action for the same address and port is staged and approved | 2 | 1 further attempt | A second row under a different claim key; the first row unchanged |
| D35 | A non-broker process holds an open connection to a pair; the pair is then added to `tcpcheck_guarded` | 1 | Further packets on that connection rejected; reject counter increases | No ledger row |
| D36 | Broker paused after the `connecting` commit; admission recovery runs for that owner; broker resumes within `T_call`, pair live | 3 | 1 attempt, by the capability whose fence is still current | Recovery left the fence unchanged and reported the slot held; the row settles with the real outcome. Reversed order (recovery first): `markConnecting` refuses `fence_superseded`; 0 SYN |
| D37 | The root-owned guarded file is restored to an older version missing a former target that the store still lists; host boots | 1 | The Jarvis service does not start; 0 SYN to the former target | Guard unit reports the mismatch; no ledger row |
| D38 | A healthy allowlisted target is kept live for more than two `T_live`, with a check at the start and one after `2 × T_live` | 1 | Both attempts accepted; the pair is present in every readback throughout | Two rows under different claim keys, both settled with the real outcome |
| D39 | Renewer stopped after its store read while holding `tcpcheck_ctl`; in a second variant the stop is inside its spawned updater, before the batch is submitted, and the renewer itself is killed; a narrowing is requested; kernel deletion is made to fail | 1 | No refresh after the narrowing commit; the pair's remaining lifetime only falls and it is gone within `T_live` of the last refresh | Narrowing committed only after the lock was actually acquired (control group killed after `T_ctl`); while a stopped updater still holds the descriptor the narrowing stays blocked and nothing is committed; epoch not advanced until absence is read back |
| D40 | During a widening the store's historical-pair write is made to fail; separately, it succeeds, the host crashes after activation, and an older guarded file is restored before boot | 1 | First variant: pair never live; 0 SYN. Second: the Jarvis service does not start; 0 SYN to the target | First: policy not activated. Second: store lists the pair, guard unit reports the file mismatch |

**The D4 probe.** A compliant broker never reaches the kernel once the control plane
has failed: it cannot commit `markConnecting`. The kernel deny is therefore
exercised by a separate test-only probe that the harness runs as `jarvis-egress`
after `T_live` and that calls connect directly. Its observation is kept apart from
the ledger attempt. The probe exists only in the test harness, is the one exception
to "no other process runs as `jarvis-egress`" (A5), and is never installed on a
commissioned host.

**D27 does not pass under 7b.** If the owner accepts the residual, D27 documents it;
it is not evidence that an expired capability is rejected at the boundary.

A case passes only if both columns are observed. Any `connected` that the packet
capture does not support, or any SYN the store cannot account for, fails the run.

## WS-E — Registry promotion

Not specified here. It stays owner-only, behind passing WS-A to WS-D evidence and
explicit sign-off.

## Obligation coverage

| Obligation (#779)                                               | Specified in                                                                 | Demonstrated by                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| 1 — freshness and revocation timing, independent deny path      | A2–A5                                                                        | D1–D6, D15, D19, D22, D25, D26, D33, D35, D37–D40 |
| 2 — durable single use at the egress boundary                   | B1, B2, B4                                                                   | D8–D11, D34                                       |
| 3 — effect boundary rejects superseded capabilities             | A6, B1a, B3                                                                  | D1–D3, D10–D12, D20, D23–D25, D32, D36            |
| 4 — eventual resolution under named assumptions                 | B3                                                                           | D10–D13, D29, D30, D32                            |
| 5 — deadline origin, timeout versus unknown, port range, window | B1a, C1–C4 (expiry at the egress boundary **not yet specified**: decision 7) | D6, D7, D14–D18, D21, D23, D24, D27, D28, D31     |

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
5. **Root-owned components.** The rule set, the renewer, the resume hook, the lock
   file, the control lock and the guard unit need root on the host. The Jarvis
   service would no longer start if the guard unit fails, including when the store
   cannot be reached at boot (A2). The control plane may kill a stopped renewer
   (A3). Confirm that is acceptable for a
   development-only capability.
6. **Ledger retention.** Keep every row indefinitely, or define an archive rule.
7. **Lease enforcement at the syscall (blocks obligation 5).** Choose 7a (enforce
   the lease in the kernel; recommended; needs its own specification) or 7b (accept
   the residual in B1a, which amends the locked scope). Also confirm `T_call` at
   1 000 ms or set another value.
8. **Clock tolerance, guard margin and reset.** Confirm 5 000 ms as the allowed
   difference between a component's clock and store time, and `T_guard` at 2 000 ms.
   Accept that exact expiry is proved only if the store's clock never steps back
   unseen by more than `T_guard` (C1), or require a second trusted time source.
   Confirm that resetting `timeHighWaterMs` is an owner-only action.

## Gates

- Planning only. No implementation, target check, allowlist entry, merge or
  deployment is authorised by this document.
- The broker, the rule set and the store mutations are each written only after the
  owner approves the corresponding workstream.
- The WS-D run needs its own authorisation after WS-A to WS-C land.
- AM-016 and `TOOL-SECURITY-TCP-CHECK` stay `planned`.
