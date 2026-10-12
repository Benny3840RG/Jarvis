# Jarvis backlog reconciliation — 2026-10-12

**Author:** Claude (independent reconciliation, read-only against `origin/main`)
**Main baseline:** `4539e53` · **Open PRs:** #722, #723, #724 (Cursor, draft), #725/#726/#728/#729 (dependabot), #730 (my superseded voice PR, recommend close)
**Sources:** `JARVIS_ROADMAP.yaml`, `docs/operations/local-v1-release-plan.md`, `docs/operations/local-v1-recovery-gap-analysis.md`, `docs/traceability/requirements-matrix.md`, `docs/operations/production-completion-ledger.md`, git history.

Status legend: **DONE** (merged, verified) · **IN-FLIGHT** (open PR) · **CODE-DONE / COMMISSION-BLOCKED** (implementation merged, needs host/credentials to prove) · **BLOCKED-APPROVAL** (needs Benny's explicit go) · **OPEN** (not started / not run).

Hard environment blockers (apply to every commissioning row): this is an ephemeral cloud container with **no supervised host shell, no real credentials** (`JARVIS_OUTLOOK_*` OAuth secret, Convex dev deployment URL+key, `SENTRY_DSN`, `POSTHOG_API_KEY`), and **no deployment authority**. The constitution forbids simulating commissioning success, so these cannot be closed from here regardless of effort.

---

## A. The real backlog — Local V1 release track (the live track)

Source of truth: `JARVIS_ROADMAP.yaml → release_tracks.local-v1` + `local-v1-release-plan.md`. **Roadmap yaml drift noted where the stored status is behind merged code.**

| Stage | What it is | Roadmap yaml | Verified reality | Blocker / next action |
|---|---|---|---|---|
| LV1-01 baseline | lock baseline; HUD/MCP/health/persistence | `ready` | Code ready | Host run to commission the baseline |
| LV1-02 voice commissioning (#567) | mic/preview/HUD commissioning | `commissioning_required` | Software merged (#696) | **Host + microphone**; software complete |
| LV1-03 Outlook send/reconcile (#294+#297) | disposable send → reconcile → dup-block | `commissioning_required` | Commissioning **kit merged** (#712); preflight **#723 in flight** | **Real Graph OAuth secret + host**; one dev-only session |
| LV1-04 voice query bridge | authoritative read answers | `planned` ⚠️ **STALE** | **DONE** — `authoritativeVoiceQuery.ts` wired in `app.ts` (#714 era) | Update yaml `planned→commissioning_required/done` |
| LV1-05 safe voice writes | voice `propose` → governed ToolAction | `planned` ⚠️ **STALE** | **DONE** — `voiceSafeWrite.ts` merged (#714) | Update yaml |
| LV1-06 Beez Treez golden flow | enquiry→client→property→job→quote→send→reconcile→invoice | `planned` | Pieces exist; end-to-end not yet run | Depends on LV1-03 commission; **host dogfood** |
| LV1-07 home daily driver | tasks/reminders/errands + Google Home announce | `planned` | Code merged (#710) | **Host + pinned Cast/Nest devices** |
| LV1-08 workshop daily driver | assets/builds/logs/maintenance; hardware fails closed | `planned` | Code merged (#710) | Host; physical adapter is V1.1 |
| LV1-09 recovery closure | capture→restore→reread→restart→rollback | `planned` | **Partial** — restart proof (#718/#721) landed; restore-fields **#722 in flight** (I reviewed it: clean, 115+12 tests green). `completeness: partial` | **Host restart re-proof** with isolated Convex; land #722 |
| LV1-10 integrated dogfood | run Jarvis for real daily use | `planned` | Not started | All above + **host** |
| LV1-11/12 release candidate & release | freeze known-good SHA, cut V1 | `planned` | Not started | **Benny-only**, after dogfood |

**LV1 verdict:** the *code* for LV1-02/04/05/07/08 is on `main`; LV1-09 is partial with a reviewed PR in flight; LV1-03 has its kit. **Everything remaining is commissioning (host + credentials) or the Benny-only release cut.** No further LV1 code is unblocked for me here without colliding with the active Cursor agent.

---

## B. Governed-development roadmap (maps to directive Priority 4, slices 20–26)

Source: `JARVIS_ROADMAP.yaml → phases` + `requirements-matrix.md` reconciliation paragraph.

| Phase | Name | Status | Reality |
|---|---|---|---|
| phase-1 | Governed development proving slice | `active` | Kernel, event contract, GitHub adapter, Ω completion all `in_progress`; **p1-stress-suite `blocked`**. Autobuild pipeline runs real missions. |
| phase-2…7 | Queue → repair → low-risk automerge → continuous → self-proposed → self-improvement | `planned` | Not started; each gated on the prior. |

Directive Priority 4 (20–26) maps onto work the requirements matrix states is **built as "maintained foundations, not commissioned"**: EventBus/ToolGateway/domain registry/memory linker/tool router (slice 20) exist at the CLI seam; reliability controller (21) at the HTTP status boundary; orchestration runner with weighted scheduling + bounded execution (24) via #325/#329/#335/#336/#344/#350; OIDC principal capture (part of 16) via #354/#356. **All offline/maintained — none commissioned against a live runtime.** "Prove under load / fire and recover" needs a real deployment.

---

## C. Directive Priority 1–4 → verified status

| Directive | Verified status |
|---|---|
| **P1 (1–7)** health immutability, CodeQL #276, security scan, CI hardening, repo cleanup, close #244, PR queue #273/#274/#277 | **ALL DONE/CLOSED 2026-08-03.** #275 merged; #276/#273/#274/#277 closed; #244 closed-complete by Benny; Actions SHA-pinned + CODEOWNERS + SECURITY.md present on `main`. |
| **P2 (8–15)** paddock, AM-012 finalize, Outlook OAuth, AM-013 delivery, reconciliation runtime, Sentry, PostHog, drills | **CODE-DONE / COMMISSION-BLOCKED.** Implementations largely merged and deliberately inactive pending commissioning (= LV1-03 + release discipline). Missing: host + `JARVIS_OUTLOOK_*`, Convex dev key, `SENTRY_DSN`, `POSTHOG_API_KEY`. |
| **P3 (16–19)** OIDC boundary (#306), secure gateway (#307), prod env, prod ops | **BLOCKED-APPROVAL / GATED.** Offline OIDC capture exists; public exposure + deploy are explicitly post-V1 and Benny-only. |
| **P4 (20–26)** intelligence core, reliability, durable engines, safety binder, orchestration, adaptive, autonomy | **Maintained foundations built, not commissioned** (see §B). Phase-1 active; stress-suite blocked. |

---

## D. Requirements matrix (R-001–R-150) — current reconciled status

From `docs/traceability/requirements-matrix.md` (reconciled to `0e7ed299`): mostly **Partial** (implementation + tests + governance evidence, range not fully closed); **Unverified** for Core modes (R-005–R-014), Memory model (R-025–R-033), Action effect/sensitivity (R-034–R-038C); **Implemented/Verified** only for Revision & freeze rules (R-144–R-150). No range is a production/commissioning claim.

---

## E. What is genuinely actionable from this cloud container (no host/creds/approval, no collision)

1. **Fix the roadmap yaml drift** — LV1-04 and LV1-05 are merged but marked `planned`. Small, correct, draft-PR-able doc fix.
2. **Independent reviews** of in-flight Cursor PRs #723 (Outlook preflight) and #724 (HUD) — same rigor as my #722 review.
3. **Turnkey commissioning checklists** for the blocked P2 rows so they're one-pass at the host.
4. **Close my superseded #730** (Benny's decision).

Everything else requires the host, real credentials, or Benny's deployment approval, or belongs to the active Cursor agent's in-flight branches.

---

## F. Exact missing items to unblock each blocked group

- **Outlook (LV1-03 / P2-10,11,12):** a dev Azure app registration + `JARVIS_OUTLOOK_*` delegated-OAuth secret; host shell to run the commissioning session.
- **Sentry (P2-13):** `SENTRY_DSN` for the project + a running runtime to emit events.
- **PostHog (P2-14):** `POSTHOG_API_KEY` + running runtime.
- **Paddock / Convex smoke / LV1-01 (P2-8):** a Convex **dev** deployment URL + service token; host.
- **Recovery (LV1-09 / P2-15 drills):** host + isolated Convex backend for the restart re-proof.
- **Remote/prod (P3-16..19):** TLS termination, public DNS/origin config, and **Benny's explicit deployment approval**.
