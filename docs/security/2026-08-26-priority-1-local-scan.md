# Priority 1 Local Whole-Repository Security Scan — 2026-08-26

## Scope and method

Exact scanned revision: `b11dc07bf1dbcce5446f08489122e4df76c205be` (`main` at merge of PR #402).

This report supersedes the prior claim that a local checkout was impossible. A fresh shallow clone of `Benny3840RG/Jarvis` at the exact HEAD above succeeded in this execution environment. The assessment combines:

- local tree inspection of TypeScript runtime, HTTP/MCP, auth, backup, workflows, and scripts;
- GitHub Code Scanning, Dependabot, and Secret Scanning alert inventory on the same revision;
- verification that `npm ci` and `npm run type-check` succeed on the locked TypeScript tree under Node 24.

This is still not a claim of production readiness, live Outlook/Sentry/PostHog commissioning, or remote exposure approval.

## Alert inventory (exact HEAD)

| Source | Open on `b11dc07` | Disposition |
| --- | --- | --- |
| Code Scanning (CodeQL) | Alerts **#2–#6** open | Same family: cache-poisoning / poisonable-step on `.github/workflows/jarvis-autobuild.yml` `verify-candidate` after checkout of `needs.build.outputs.candidate-sha` under `workflow_dispatch` |
| Dependabot alerts | **None open** | No open dependency vulnerability alerts |
| Secret scanning | **None open** | No open secret alerts |
| Repository advisories | **None** | — |

### CodeQL alerts #2–#6 — residual analysis

PR #393 already removed explicit npm caching from the untrusted `verify-candidate` job. On current HEAD that job:

- checks out the candidate SHA with `persist-credentials: false`;
- sets up Node **without** `cache: npm`;
- runs policy validation, `npm ci`, audit, type-check, lint, format, OpenAPI, coverage, and Console build;
- holds only `contents: read`.

The **build** job (trusted `main` checkout) still uses `cache: npm`; that is intentional and out of the untrusted-candidate path.

CodeQL continues to flag **every step after the untrusted checkout** because the workflow is triggered by `workflow_dispatch` / issue label in the default-branch cache scope. Removing npm cache reduced the practical write channel but does not change the structural rule: executing untrusted tree content in default-branch context remains a poisonable pattern under CodeQL’s model.

**Disposition:** accepted residual risk of the current autonomous verify design, with mitigations:

1. only repository writers may authorise a run;
2. issue lock + eligibility gate before candidate production;
3. no credentials persisted on the candidate checkout;
4. no npm cache on `verify-candidate`;
5. control-plane files installed immutably under `/opt/jarvis-autobuild` before agent work in the build job.

**Follow-up (not blocking P1 close of the scan itself):** redesign verification so untrusted candidate execution occurs only in a PR-branch-scoped check (not default-branch `workflow_dispatch` context) if/when CodeQL closure is required.

## Local surface assessment

| Area | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| Health-evidence immutability | `HealthMonitor` freezes metrics and nested metric objects; returns readonly frozen array | — | Verified remediated (PR #278) |
| HTTP bind / remote gateway | Default host loopback; non-loopback requires remote gateway config (OIDC, TLS terminator trust, origin allowlist, body limit, rate limit) | — | Implemented; live IdP commissioning remains #306 |
| MCP host / API origin | Loopback host enforcement; non-loopback API origin rejected until remote gateway | — | Verified (prior #280) |
| Service token / approval token | Shared Bearer service token for loopback operator boundary; separate approval token required for approve/revoke | Residual for remote | Acceptable only while loopback; Priority 3 OIDC gate remains |
| Outlook refresh token store | Absolute path, `O_NOFOLLOW`, mode checks, no symlink, size bounds, atomic replace | — | Sound design; live OAuth still #293 |
| Backup read | Rejects symlinks via `lstat`; `O_NOFOLLOW` open; size limit | — | Sound |
| Dynamic JS / child_process | `new Function` confined to test helpers for widget evaluation; production `child_process` limited to smoke/commissioning/hygiene scripts with fixed argv | Low | Accepted; no user-controlled eval sink found in runtime entrypoints |
| Workflow SHA pinning | All `uses:` references observed as full commit SHAs; `persist-credentials: false` on checkouts | — | Verified |
| CODEOWNERS / SECURITY.md | Present and covering control-plane, auth, HTTP/MCP, Convex, registries | — | Verified |
| npm install scripts | `strict-allow-scripts` + explicit deny for esbuild/fsevents (PR #401) | — | Verified |
| Repository hygiene | `check-repository-hygiene.mjs` in `npm run check` (PR #394) | — | Verified |
| Outlook on without reconciliation | Fail-closed pairing guard (PR #402) | — | Verified on HEAD |

## Verification commands (local)

On exact tree `b11dc07`:

```text
git clone --depth 1 https://github.com/Benny3840RG/Jarvis.git
cd Jarvis && git rev-parse HEAD   # b11dc07bf1dbcce5446f08489122e4df76c205be
cd typescript && npm ci           # success
npm run type-check                # success (tsc root + convex)
```

## Residual risks (not misclassified as fixed)

1. **CodeQL #2–#6 open** — structural default-branch untrusted-verify pattern; mitigations above; redesign tracked as follow-up.
2. **Branch protection on `main` not enforced** — issue #398; cannot be fixed from this session’s tool surface.
3. **Shared service-token model** — loopback-only; remote requires #306.
4. **Outlook / Sentry / PostHog / production** — external secrets or human deployment gates (#293, #294, #297, #302, #303, #307).

## Slice status relative to Priority 1 item 3

- Connector-backed triage: previously recorded.
- **Local whole-repository assessment on exact HEAD: completed by this report.**
- Open CodeQL alerts: triaged with explicit residual-risk acceptance and follow-up redesign note — not left as an anonymous scanner pile.
- Issue #399 may close when the owner accepts this residual disposition, or remain open until CodeQL #2–#6 are cleared by redesign.

No production deployment, customer email, or remote exposure was performed.
