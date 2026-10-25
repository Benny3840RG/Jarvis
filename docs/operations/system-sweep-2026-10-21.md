# Jarvis maintenance sweep — 21 October 2026

Mission: [#745](https://github.com/Benny3840RG/Jarvis/issues/745).
Repository baseline: `1c5d8255fc27d51329e3009499c0d9e02b61444e`.

This is a bounded housekeeping inspection and repair record, not a production,
security-certification or Local V1 completion claim. Repository evidence and a
read-only inspection of the connected Lenovo were available. No live customer
workflow, credentials, production database, send, approval or deployment was used.

## Findings and disposition

| Area                    | Evidence observed                                                                                                                                 | Disposition                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main application checks | TypeScript checks run `39537854342`: typecheck/lint/format/Node/Convex/OpenAPI, automation policy and console build passed                        | Reuse this baseline proof; require fresh candidate CI for this maintenance PR                                                                    |
| HUD CI                  | Job `119018556152` passed all six real browser scenarios, then failed removing its profile with `ENOTEMPTY`; the same race occurred on PR #739    | Add bounded native removal retries; persistent errors still fail                                                                                 |
| Agent handovers         | Both handovers required advisory maintenance review success despite the current policy in `branch-protection.md` and `dual-agent-coordination.md` | Align both with the decided policy; retain exact-head required CI, mission proof, independent peer review, concrete findings and owner decisions |
| Advisory reviewer       | Review run `39537836805`, job `119018565927`, failed invoking the model with `Quota exceeded. Check your plan and billing details.`               | External quota blocker; no extra retries, gate weakening or claim of a model review PASS                                                         |
| Queue and collisions    | No open PRs or active autonomous builder at inspection; none of the 12 existing open issues held an automation-in-progress lock                   | Claim only #745 for this bounded maintenance work                                                                                                |
| Lenovo services         | Both user-scoped services active/running, enabled, zero automatic restarts, successful exit status; restart-on-failure with 5 s delay             | Healthy at inspection; system-scope units being inactive is not a fault                                                                          |
| Lenovo endpoints        | `/healthz` returned status ok; MCP root returned HTTP 200; ports 3000 and 8787 listened on loopback                                               | Reachability only, not authenticated end-to-end workflow commissioning                                                                           |
| Live version            | Both services ran from clean checkout `2d34a741abbba9167f404a0dd476001c71c7ea31`                                                                  | Host is behind repository main; do not silently pull or restart a working runtime                                                                |
| Host resources          | About 4.6 GiB available memory and 200 GiB free root disk; no failed system units                                                                 | No capacity-driven cleanup justified; no files or processes removed                                                                              |
| Security issue #703     | Root lock has shell-quote 1.11.0 and concurrently 10.0.6; both MCP clients resolve 2.3.1, console mcp-use is 2.10.0                               | Original vulnerable versions are superseded; owner can reconcile the old issue after accepting current audit evidence                            |
| TypeScript #561         | Root is TypeScript 6.0.3 with typescript-eslint 8.71.2; console independently uses TypeScript 7.0.2                                               | Keep the root/tooling deferral; console's separate compiler does not prove root lint-stack compatibility                                         |

## Release and commissioning truth

The latest release-tracker comments supersede the earlier claim that Outlook was
waiting solely on credentials. The 18 October record on #697 reports a governed,
allowlisted non-customer Outlook send, reconciliation and inbox/PDF confirmation.
It also lists missing evidence and explicitly says this is evidence, not acceptance.
Issues #294 and #297 therefore remain open; do not repeat the live send merely to
make the issue list shorter.

The LV1-09 quote-over-restart step was accepted in the ledger on 17 October. That
acceptance explicitly does not declare recovery or Local V1 complete. Voice #567,
Google Home announce-only commissioning, integrated dogfood, release-candidate
freeze and Local V1 release still need their actual evidence/decisions.

Keep #306 (remote identity/exposure), #307 (production operations) and #324 (live
durable orchestration) open behind their stated prerequisites. They are deliberately
not Local V1 blockers. Keep photo annotations #734 and cutting optimiser #742
parked; do not start those features during housekeeping. Cybersecurity capability
#732 is separate feature work, not a cleanup dependency.

## Repair and validation boundary

The code repair uses Node 24's documented recursive `fsPromises.rm` retry behaviour:
`maxRetries: 5`, `retryDelay: 100`. Native transient errors receive linear backoff;
errors remaining after the finite budget still reject. No catch converts cleanup,
layout, browser startup or JavaScript failures into success. See the
[Node 24 filesystem API](https://nodejs.org/download/release/v24.20.0/docs/api/fs.html#fspromisesrmpath-options).

Existing HUD tests are retained. This one-option library configuration change does
not add a test that merely duplicates Node's own removal implementation. Fresh
real-browser CI, maintained application/Convex checks, audits and independent
candidate review provide the repair evidence. Record their exact candidate and
results on the draft PR; this report is not itself evidence that pending CI passed.

## Owner follow-through

1. Review the maintenance candidate after exact-head CI and independent review.
2. Resolve the model-review account quota if automated advisory reviews are wanted.
3. Plan an explicit host update/rollback against a chosen release SHA before pulling
   current code or restarting the Lenovo services.
4. Accept or request the outstanding Outlook evidence, then complete the remaining
   voice/home/dogfood/release checks on the chosen Local V1 candidate.

No issue was closed, commissioning evidence accepted, production setting changed,
secret read, live service restarted or runtime updated by this sweep.
