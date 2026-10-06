# Jarvis Local V1 fast-track release plan

**Date:** 2026-10-06  
**Tracker:** #697  
**Release target:** JARVIS LOCAL V1  
**Repository:** `Benny3840RG/Jarvis`

## Objective

Ship a stable, locally operated Jarvis that Benny can use every day across The Beez Treez business, home and workshop without routine developer intervention.

Local V1 is an operational release track. It does not replace the canonical governed-development/autonomy phases in `JARVIS_ROADMAP.yaml`.

The implementation order remains:

1. REUSE
2. EXTEND
3. HARDEN
4. NEW

Fast-tracking means removing unnecessary work, not removing tests, authority checks, recovery, idempotency, review or evidence.

## V1 scope

### Business

The normal path must work end to end:

`enquiry → client → property → project/job → quote draft/edit/finalise/PDF → governed Outlook send → reconciliation → invoice draft → daily brief/HUD`

V1 must support practical read/write use of clients, properties, projects, enquiries, quote drafts, invoices and scheduling through supported Jarvis interfaces.

### Home

V1 must make tasks, reminders, errands and preferences usable every day, including authoritative voice reads/writes. The existing governed Google Home/Nest announcement path is commissioned against explicitly pinned devices.

### Workshop

V1 must make assets, builds, build logs, upgrades, maintenance information, tasks and parts/errands usable through MCP/HUD/voice.

Physical machine actuation is not a Local V1 blocker. Uncommissioned hardware must fail closed and report unavailable.

## Current open-issue mapping

### Direct Local V1 blockers

- **#567 Guarded voice:** implementation is merged via PR #696. Remaining V1 work is local preview/HUD/microphone commissioning under the existing runbook. Physical equipment commissioning is separate.
- **#294 + #297 Outlook:** execute one shared non-customer development send/reconcile exercise. Evidence from the same run is used for both issues.

### Intentionally non-blocking for Local V1

- **#561 TypeScript 7:** keep blocked until a compatible lint/tooling stack exists.
- **#306 Remote OIDC/gateway:** required before remote/public exposure, not before Local V1.
- **#307 Production operations/deployment:** final production gate, not Local V1.
- **#324 Durable orchestration commissioning:** offline work is already merged; live commissioning remains behind the real runtime/identity/recovery prerequisites.

## Baseline security reconciliation

The first verification run for this plan exposed a newly published high-severity `source-map-js@1.2.1` advisory in the unchanged root dependency tree. Issue #699 and PR #700 repaired the root lockfile to patched `source-map-js@1.2.2` without weakening the audit gate. PR #700 merged before final verification of this roadmap candidate.

## Execution sequence

### LV1-01 — Baseline lock

- Sync exact current `main`.
- Clean working tree.
- `npm ci`.
- `npm run check`.
- `npm run openapi:lint`.
- Verify authorised Convex development configuration.
- Start local preview.
- Verify HUD, MCP, health/status and persistence.
- Smoke one create/read/update flow for task, reminder, errand, asset, build, client, property, project, enquiry, invoice draft and quote draft.

**Exit:** one exact source SHA is the Local V1 integration baseline.

### LV1-02 — Voice commissioning (#567)

Run the maintained voice commissioning procedure:

- typed fallback;
- microphone capability where available;
- wake-word gating;
- final-only dispatch;
- confirmation/cancel;
- profile/reset/manual-override invalidation;
- interruption;
- at least 10 measured browser dispatch round trips;
- absent hardware fails closed.

**Exit:** voice software is commissioned for Local V1. Hardware remains unavailable until a separate adapter is commissioned.

### LV1-03 — Outlook send/reconciliation (#294 + #297)

One non-customer development exercise:

1. create/finalise disposable quote;
2. governed `quotes:send`;
3. capture immutable Graph provider/message ID;
4. allow reconciliation to reach one terminal result;
5. repeat the same delivery scope;
6. prove duplicate send is blocked.

**Exit:** issue-specific evidence satisfies both #294 and #297.

### LV1-04 — Authoritative voice query bridge

Connect deterministic voice query intents to existing read models/APIs.

Initial query coverage:

- jobs today/this week;
- unpaid invoices;
- open enquiries;
- quote follow-up;
- tasks/reminders/errands;
- workshop builds/assets/maintenance;
- trailer/crawler recorded status where authoritative data exists.

No raw-storage voice queries and no second business read model.

**Failure rule:** unavailable data returns unavailable, never an invented answer.

### LV1-05 — Safe voice writes

Map safe voice intents onto existing API/MCP/ToolAction paths for tasks, reminders, errands and appropriate draft/log operations.

Voice never gains its own execution or approval system.

### LV1-06 — Beez Treez golden workflow

Run one realistic fictional/non-customer job through the complete supported lifecycle without editing backing storage manually.

Verify the resulting truth appears consistently in daily brief, HUD, MCP and voice reads.

### LV1-07 — Home daily driver

Prove tasks, reminders, errands and restart persistence. Commission the existing Google Home announcement path against explicitly pinned local devices.

Do not broaden into universal Cast/media/home automation.

### LV1-08 — Workshop daily driver

Prove assets, builds, build logs, upgrades, maintenance records and workshop voice reads/writes.

Physical machine control remains V1.1 unless a separately reviewed low-risk adapter can be commissioned without delaying Local V1.

### LV1-09 — Recovery closure

The authoritative Local V1 dataset must be recoverable, including the records actually relied upon by V1: business records, quote lifecycle/revisions/artifacts/delivery state, tasks/reminders, workshop records and relevant settings.

Required proof:

`capture/export → validate → isolated restore → normal store/API reread → reference/artifact checks → runtime restart → rollback proof`

A partial archive is not full recovery evidence.

### LV1-10 — Integrated dogfood

Use Jarvis as the operating assistant rather than as a test target.

Any repeated need to bypass Jarvis because a required V1 path is unreliable, confusing or incomplete is a release-blocking usability defect until repaired or explicitly removed from V1 scope.

### LV1-11 — Release candidate

Freeze one exact SHA and run:

- full maintained checks;
- OpenAPI lint;
- affected security/governance checks;
- voice regression;
- business golden workflow;
- home/workshop daily-driver proof;
- Outlook reconciliation proof;
- recovery proof;
- restart proof;
- independent correctness/security/authority review.

### LV1-12 — Release

Record:

- exact release SHA;
- check/evidence references;
- known limitations;
- Local V1 operator runbook.

Then designate the candidate **JARVIS LOCAL V1**.

## Physical control after Local V1

The first physical adapter is V1.1 work and must be one low-risk, explicitly whitelisted device. It requires real identity/state readback, idempotency, timeout, receipt/reconciliation, manual override and independent physical safety/interlocks where applicable.

Software confirmation is never a substitute for safe hardware.

## Remote/production after Local V1

After Local V1 is stable:

1. #306 real OIDC/TLS/public gateway commissioning;
2. #307 production runtime, recovery, secret rotation, rollback, monitoring and explicit release approval;
3. #324 live durable orchestration commissioning against that real runtime.

## Release discipline

- Do not build duplicate authority, approval, execution, evidence, completion or persistence systems.
- Implemented/configured does not mean commissioned.
- No speculative refactors while a Local V1 P0/P1 path is open.
- Failed external effects remain failed/indeterminate according to existing evidence rules.
- Intentionally deferred issues may remain open without blocking Local V1.
- Local V1 is complete only from evidence on one exact candidate, not from issue-count reduction.
