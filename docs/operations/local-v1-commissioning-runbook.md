# Jarvis Local V1 commissioning runbook

**Audience:** Benny (owner/operator), running on the J-arvis host.
**Tracker:** #697. **Release plan:** `docs/operations/local-v1-release-plan.md`.
**What this is:** the host-side sequence that turns the green code baseline into
the evidence #697's definition of done requires. Every stage names the
environment it needs and an explicit pass / stop line. The stages that are
executable as commands — 0–2 (baseline, checks, local runtime), 4 (Outlook), and
6 (home) — give those commands exactly; the rest — 3 (voice), 5 (golden
workflow), 7 (workshop), 9 (dogfood), and 10 (release) — are operator procedures
that cite the detailed steps in the referenced runbook/operator docs rather than
a single command. **Stage 8 (recovery + restart) is the exception and is not
turnkey:** the Local V1 recovery proof has no operator command today — only an
off-host test invocation plus a manual host procedure — so Stage 8 is marked
BLOCKED until a `commission:local-v1-recovery` wrapper is built and reviewed (a
separate code change, out of scope for this doc).

**What this is not:** a merge or deploy authority. Per
`docs/operations/dual-agent-coordination.md`, merge, deployment and
commissioning sign-off are the owner's alone. A green command here is
*evidence to read*, never an automatic completion. "Implemented/configured does
not mean commissioned."

Record every stage's result (command, host, candidate SHA, raw output or a path
to it) in a running evidence log kept **outside the repository** (secrets and
customer-shaped data must never be committed). Capture files written with mode
`0600`.

---

## Stage 0 — Candidate lock (LV1-01, execution step 1)

Freeze one exact SHA. Everything below is evidence *for that SHA only*; a new
commit or base change invalidates all prior stage evidence.

```sh
cd typescript
git fetch origin main
git log -1 --format='HEAD %H %ci'      # record this SHA as the candidate
git status                             # must be clean
node -v                                # must satisfy typescript/.nvmrc (24.x)
npm ci
```

**Pass:** clean tree, Node 24.x, `npm ci` completes with 0 vulnerabilities.
**Stop:** dirty tree, foreign commits, Node mismatch, or install failure.

---

## Stage 1 — Maintained checks + OpenAPI lint (LV1-01) — code gate

This is the one gate already provable in CI/off-host. Re-run it on the frozen
candidate so the evidence is bound to that exact SHA.

```sh
cd typescript
npm run check          # hygiene + tsc(src+convex) + eslint + prettier + node & convex tests
npm run openapi:lint   # redocly — must say "valid" with zero warnings
```

**Reference result (verified on `ee3340e`, 2026-10-25):** `npm run check`
`EXIT=0` — convex 464/464, node 2599 pass / 1 skip / 0 fail; `openapi:lint`
"Your API description is valid 🎉", zero warnings.

**Pass:** both exit 0; OpenAPI zero warnings.
**Stop:** any failure. Do not weaken a test or threshold to go green — fix the
cause on a branch, re-freeze, and restart from Stage 0.

---

## Stage 2 — Local runtime lock + HUD/MCP usability (LV1-01, DoD items 1 & 3)

Stand up the real backend against the **pinned development Convex deployment**
(never production, never a customer deployment). This covers the DoD items
"one known-good local runtime is locked and verified" and "HUD and MCP are
usable against the selected development persistence."

### 2a. Credential-free boot sanity (no Convex needed)

Proves the HTTP + MCP wiring on this host before you attach credentials:

```sh
cd typescript
node --import tsx .claude/skills/run-jarvis-backend/driver.mjs smoke
```

**Pass:** all checks PASS, exit 0 (healthz, status, task create/get/complete,
MCP initialize, tools/list).

### 2b. Real runtime against the dev deployment

Required environment (shell or ignored `.env.local`, **never** a command
argument):

| Variable | Value |
| --- | --- |
| `PERSISTENCE_PROVIDER` | `convex` |
| `CONVEX_DEPLOYMENT` | `dev:<slug>` (an unquoted trailing `# comment` is stripped; `dev:slug#note` glued is refused) |
| `CONVEX_URL` | loopback, or exactly `https://<slug>.convex.cloud` for that dev slug |
| `JARVIS_SERVICE_TOKEN` | ≥ 32 characters (a short/placeholder token is rejected) |
| `JARVIS_TIMEZONE` | your local IANA zone (e.g. `Australia/Sydney`) — drives brief/reminder display |

```sh
# HTTP first (binds 127.0.0.1:3000 by default), then MCP (proxies to HTTP), then the HUD preview.
npm run start:http
npm run start:mcp        # needs JARVIS_API_BASE_URL + JARVIS_SERVICE_TOKEN pointing at the running HTTP
npm run start:preview    # open the HUD on the loopback address it prints
```

Usability checks (loopback only — the HUD snapshot and voice routes are
loopback-public *only* on the preview bind; off-loopback they still require the
service token):

```sh
curl -s http://127.0.0.1:3000/healthz                      # 200, no auth
curl -s -H "Authorization: Bearer $JARVIS_SERVICE_TOKEN" \
  http://127.0.0.1:3000/api/v1/status                      # 200
curl -s http://127.0.0.1:3000/api/v1/hud/snapshot          # loopback-only snapshot
```

Open the HUD in a browser on the preview address; confirm it renders the
snapshot (tasks/reminders/brief sectors) without JavaScript errors. Drive a
read via the MCP server from a chat client and confirm it returns live data.

**Pass:** dev runtime boots on Convex; healthz/status/HUD snapshot/MCP all
return live data; HUD renders.
**Stop:** boot fails (re-run via a one-off `createJarvisHttpApp()` script to see
the real error — `main.ts` swallows it), HUD errors, or MCP cannot reach HTTP.

> Keep this runtime (or a fresh identical boot) up for Stages 3–8.

---

## Stage 3 — Guarded voice commissioning (LV1-02, #567, DoD item 4)

Follow `typescript/docs/operators/voice.md` exactly. Summary of the mandatory
evidence:

1. Open **Voice** in the HUD; record browser/OS and **MIC AVAILABLE** vs **TYPED ONLY**.
2. Typed read-only query (`Jarvis any unpaid invoices`): empty register → "none",
   not a guessed count; unreadable source → named unavailable, never a fake answer.
3. Unknown phrase → rejected, nothing pending.
4. Typed safe write (`Jarvis add a task`, `Jarvis remind me to follow up`): stages a
   ToolAction only with the wake word + a commissioned project target + required
   capture (title; task also needs a category). No wake word → writes nothing.
   Spoken confirm never approves a quote send/draft.
5. `Jarvis crawler halt` → **awaiting confirmation**; `Jarvis cancel` clears it.
6. Re-arm + `Jarvis confirm` → **actuation unavailable / failed closed** on the
   absent-hardware provider. **Any success here is a stop condition.**
7. Profile change while a critical command is pending → confirmation invalidated,
   mic aborted.
8. Workshop start then stop → earlier start no longer pending; later confirm does nothing.
9. **Stop** mid-dispatch → buffered/late results cannot dispatch or restore state.
10. Profile switch in flight → old responses don't restore prior profile/pending.
11. Expired-session response → fresh command creates a new session, no replay.
12. **Microphone checks** (only if speech recognition is supported and you press
    **Enable microphone**): no-wake-word speech never dispatches; final-only
    dispatch; arm/cancel/confirm fail-closed; Stop aborts recognition + TTS.
13. **Latency:** record **≥ 10** observed Dispatch round-trip samples with
    browser/host + candidate SHA; report raw values + median + worst. There is no
    invented pass threshold — this establishes the host baseline.

**Pass / stop:** exactly as the voice.md "Pass / stop conditions" section. Stop
if a partial/ambiguous utterance actuates, a spoken confirm bypasses the
governed boundary, a voice write approves/executes itself, a consequential
proposal creates an effect, a pending confirmation survives
profile/reset/override, a remote unauthenticated request reaches a voice route,
or absent hardware reports success.

> DoD items 5 ("voice read queries authoritative") and 6 ("safe voice writes
> reuse existing paths") are already checked on #697 by merged tests; Stage 3 is
> the live commissioning evidence for #567.

---

## Stage 4 — Outlook send/reconcile (LV1-03, #294 + #297, DoD item 7)

One disposable, **non-customer** quote send + reconciliation. Follow
`docs/operations/outlook-quote-commissioning.md` — the guardrails there
(recipient allowlist, canonical-mailbox client-contact refusal, dev-only
deployment, loopback API) run *before* anything is created. Do not shortcut them.

With Jarvis HTTP listening on loopback and reconciliation enabled, from `typescript/`:

```sh
npm run commission:outlook-quote
```

Required environment (shell or ignored `.env.local`, never a command argument):

- `JARVIS_ENVIRONMENT=development`
- `CONVEX_DEPLOYMENT=dev:...`, `CONVEX_URL` loopback or `https://<slug>.convex.cloud`
- `JARVIS_API_BASE_URL` loopback
- `JARVIS_RECONCILIATION_ENABLED=true`
- `JARVIS_SERVICE_TOKEN`, `JARVIS_APPROVAL_TOKEN`
- `JARVIS_OUTLOOK_COMMISSIONING_PROJECT_KEY` (an **existing** Convex totality project — the kit does not create it)
- `JARVIS_OUTLOOK_COMMISSIONING_CONFIRM=non-customer`
- `JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT` (a plain `local@domain`, not a customer)
- `JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST` (comma-separated plain mailboxes; required, recipient must match exactly)
- the existing Outlook runtime vars that register `quotes:send`
- `JARVIS_OUTLOOK_COMMISSIONING_CONNECTION` only when named connections are enabled
- optional: `JARVIS_OUTLOOK_COMMISSIONING_EVIDENCE=<absolute path outside the repo>` to also write the JSON `0600`

The run drafts → edits → reviews → finalises a quote, stages+approves+executes
one governed `quotes:send`, captures the immutable Graph `providerRequestId`,
runs reconciliation to one `resolved`, then **proves a duplicate send is
blocked** (second send `failed`/`blocked`, ledger still one attempt).

**Pass:** one `resolved` reconciliation for the message id, duplicate send
blocked. Note: stdout `issues` stays `{"294":"OPEN","297":"OPEN"}` and
`satisfied:false` by design — the JSON is **evidence for you to review**; the
issues stay open until you accept the run. A nonzero exit is a failed proof, not
a send.
**Stop:** any guardrail refusal you did not expect, a send to a customer
mailbox, or a duplicate send that is not blocked.

---

## Stage 5 — Beez Treez golden workflow (LV1-06, DoD item 8)

Run one realistic **fictional/non-customer** job through the whole lifecycle via
supported interfaces (MCP/HTTP/HUD) — **never** by editing JSON on disk:

`enquiry → client → property → project/job → quote draft → edit → finalise → PDF
→ governed send + reconciliation → invoice draft → daily brief / HUD`

Then verify the **same truth** appears consistently across daily brief, HUD, MCP
reads, and voice reads. (The send/reconcile here can reuse the Stage 4 mechanism
against the non-customer recipient; do not send to a customer.)

**Pass:** the job is creatable and advanceable end to end through supported
surfaces, and brief/HUD/MCP/voice agree on its state.
**Stop:** any step forces you to hand-edit storage, or the surfaces disagree
(e.g. brief shows the flat quote register while HUD shows the Convex lifecycle —
note which, that split is documented in the recovery gap analysis).

---

## Stage 6 — Home daily driver + Google Home (LV1-07, DoD item 9)

1. Prove tasks, reminders, errands are usable day-to-day through MCP/HTTP/HUD/voice,
   and that they survive a runtime restart (see Stage 8).
2. Commission the existing governed announcement path against **explicitly
   pinned** devices only. Discover devices, then produce the evidence kit:

```sh
cd typescript
npm run home:discover                                  # list reachable Cast devices
npm run home:kit                                       # writes one evidence package
npm run home:kit -- --out /tmp/jarvis-google-home-kit.json
```

Pin targets via `JARVIS_GOOGLE_HOME_TARGETS_JSON` and voice via
`JARVIS_GOOGLE_HOME_TTS_VOICE` (default `en-au`); optional
`JARVIS_GOOGLE_HOME_DISCOVERY_TIMEOUT_MS`. The kit writes
`commissioningClaimed: false` — it does **not** approve, execute a ToolAction, or
add a Cast path. It is evidence only.

**Pass:** tasks/reminders/errands usable + restart-durable; announcement path
reaches the pinned devices via the governed path.
**Stop:** any attempt to broaden into universal Cast/media/home automation — out
of V1 scope.

---

## Stage 7 — Workshop daily driver (LV1-08, DoD item 10)

Prove assets, builds, build logs, upgrades and maintenance records are usable as
the daily workshop surface through MCP/HUD/voice (create/read/update). Physical
machine control stays **V1.1** — uncommissioned hardware must report unavailable
and fail closed (already covered by Stage 3 step 6 and the absent-hardware tests).

**Pass:** the workshop record surface is usable through supported interfaces.
**Stop:** any reliance on uncommissioned physical actuation.

---

## Stage 8 — Recovery + restart (LV1-09, DoD items 11 & 12)

**Status: BLOCKED — no single operator command exists for this stage.** The
capture → restore → reread code and the restart harness exist and pass off-host,
but there is **no** `commission:local-v1-recovery` (or equivalent) script:
`captureLocalV1Archive`, `restoreLocalV1Archive`, `proveLocalV1Recovery` and
`readRestartedProcess` are invoked only from tests, not from `package.json` or
`src/tools/`. The realistic end-to-end restart on realistic data is **NOT YET
MET** and must be repeated on this host against an **isolated self-hosted
convex-local-backend** (never the shared dev deployment).

### 8a. Off-host proof (exact command, verified)

This runs the proof gate (`proveLocalV1Recovery`) and the restarted-process
harness (`readRestartedProcess`) on bounded synthetic fixtures / injected
isolated stores — the portion reproducible without a host backend:

```sh
cd typescript
node --import tsx --test tests/localV1Proof.test.ts tests/localV1ProcessRestart.test.ts
```

**Expected (verified on `918e753`, 2026-10-25):** `tests 7 … pass 7 … fail 0`,
exit 0 — including "serves the same client, task, build, and quote GET from a
second HTTP app" and "compares quote GET across two isolated processes when the
delivery token is set". This is harness-level evidence on synthetic data, **not**
the realistic host end-to-end proof in 8b.

### 8b. Host end-to-end restart (manual — no wrapper exists yet)

Key rules (from `typescript/docs/operators/archive-v4.md` and the gap analysis):

- The Local V1 gate is `proveLocalV1Recovery`, which calls `restoreLocalV1Archive`
  into a new JSON directory + an injected empty database. It does **not** write
  the live data directory and does **not** construct a client from `CONVEX_URL`.
- `completeness` stays `partial` by design; `assertRecoverable` still throws. A
  partial archive, including a Local V1 capture, is **not** a full recovery.
- The restart criterion (`readRestartedProcess`) spawns `src/http/main.ts`, GETs
  a client/task/build, kills it, respawns, and requires the bodies to match. The
  JSON default leaves the quote unrecovered; the quote GET requires pointing the
  harness at an **isolated** Convex URL, and that mode passes the caller-supplied
  `JARVIS_DELIVERY_RUNTIME_TOKEN` to the child. It refuses the configured
  `CONVEX_URL` (by host+port, scheme-insensitive, loopback aliases included, and
  any `.convex.cloud`/`.convex.site`).

Host action required (manual, no packaged command): stand up the isolated
convex-local-backend on `127.0.0.1`, supply `JARVIS_DELIVERY_RUNTIME_TOKEN`,
capture a Local V1 archive with `captureLocalV1Archive`, restore it with
`restoreLocalV1Archive` into a fresh JSON directory plus the isolated backend,
then repeat the restart step so a restarted `src/http/main.ts` serves matching
client/task/build **and quote** GETs. Because these functions have no CLI entry
today, this currently needs a small driver script; packaging it as a reviewed
`commission:local-v1-recovery` command — with exact setup, invocation,
expected-output, evidence-capture and teardown — is the smallest way to make this
stage turnkey, and is tracked as follow-up, not done here.

Prior evidence: quote GET across a real restart is **PROVEN** at `2d34a741`
(host `~/lv1-01/restart-proof.md`, quote sha256 `c7fd9977…dbb8`, with
workarounds). A `990bd8c2` re-proof passed capture/restore/field-fidelity/sha256
and failed only the restart step for a missing delivery token (now passed by the
harness). Realistic end-to-end recovery stays **NOT YET MET** until this host
repeats the restart step.

Danger-zone note: `clear-local` no longer accepts a classic verify receipt that
omits core/memory/business checksums. Do not quarantine business JSON on the
strength of a backup that does not contain it.

**Pass:** isolated restore + a restarted process returning matching
client/task/build/quote GETs on realistic data.
**Stop:** any run that targets the configured live `CONVEX_URL`, flips
`completeness` to `complete`, or claims recovery from a partial archive.

---

## Stage 9 — Integrated dogfood (LV1-10, DoD item 13)

Use Jarvis as the operating assistant across business/home/workshop, not as a
test target. Any repeated need to bypass it because a V1 path is unreliable,
confusing or incomplete is a **release-blocking usability defect** until repaired
or explicitly removed from V1 scope. Record each bypass.

**Pass:** no unresolved release-blocking usability defect.
**Stop:** a V1 path you keep having to work around.

---

## Stage 10 — Freeze, independent review, release (LV1-11 / LV1-12, DoD items 14 & 15)

On one frozen candidate SHA, assemble:

- Stage 1 checks + OpenAPI lint (green);
- affected security/governance checks;
- voice regression + the Stage 3 commissioning evidence;
- the Stage 5 golden-workflow evidence;
- Stage 6/7 home + workshop daily-driver evidence;
- Stage 4 Outlook reconciliation evidence;
- Stage 8 recovery + restart proof;
- an independent correctness/security/authority review with no unresolved blocker.

Then record: exact release SHA, check/evidence references, known limitations, and
this runbook as the Local V1 operator runbook. Only then designate the candidate
**JARVIS LOCAL V1**.

**This designation is the owner's decision.** No agent, check, or machine review
makes it.

---

## Quick status map to #697 definition of done

| DoD item | Stage | Owner-only / host-side? |
| --- | --- | --- |
| maintained checks + OpenAPI lint | 1 | provable off-host (✅ green on `ee3340e`) |
| known-good runtime locked | 0 + 2 | host |
| HUD + MCP usable on dev persistence | 2 | host |
| #567 voice commissioning | 3 | host (real mic) |
| voice read queries authoritative | — | ✅ merged tests |
| safe voice writes reuse paths | — | ✅ merged tests |
| #294 + #297 Outlook | 4 | host (live mailbox) |
| golden workflow end to end | 5 | host |
| home + Google Home commissioned | 6 | host (pinned devices) |
| workshop daily-driver | 7 | host |
| dataset recoverable (isolated restore) | 8 | host (isolated backend); **BLOCKED — no operator command, off-host tests only (8a), host end-to-end NOT YET MET** |
| restart preserves state, hardware fails closed | 8 + 3 | host |
| dogfood, no blocker | 9 | host |
| independent review, no blocker | 10 | owner |
| exact SHA + evidence + runbook recorded | 10 | owner |

## Out of Local V1 scope (do not let these block)

- #561 TypeScript 7 — deferred until tooling catches up.
- #306 remote OIDC/TLS/public gateway — before remote exposure, not Local V1.
- #307 production runtime/deployment — the production gate, after Local V1.
- #324 live durable orchestration — behind #306/#307.
- Physical machine actuation — V1.1, separately reviewed low-risk adapter.
