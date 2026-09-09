# Data-path security review (A5)

Scope: persistence, backup/import, business records, and dashboard data handling.
For each, the review traces four boundaries — **ownership**, **parsing**,
**mutation**, and **output**. Findings below are validated against the code, not
inferred; each "sound" entry names the mechanism that makes it sound so a later
change that removes the mechanism is visibly a regression.

Review date: 2026-09-10. Base: `main` @ `612d596`.

## Findings requiring remediation

### G1 — Problem-details redaction covered only the service tokens (fixed here)

`ProblemDetailsFilter` redacted `currentToken` / `previousToken` out of the
problem `detail` and `instance`, but the same `HttpAppConfig` also carries
`currentApprovalToken` / `previousApprovalToken` (consumed by
`toolActionController.ts` to gate tool-execution approval). The lower-value
credential was protected and the higher-value one was not.

**Fix:** `configuredSecrets(config)` is now the single list of every configured
bearer credential, used by the filter for both fields. Anything secret added to
`HttpAppConfig` belongs in that helper.

### G2 — Request-id reject-list covered only the service tokens (fixed here)

`app.ts` `genReqId` passed `[currentToken, previousToken]` to `resolveRequestId`.
The intent is clear: a caller-supplied `X-Request-Id` is echoed back in the
response header and lands in logs, so a configured credential must never be
accepted as one. The approval tokens were omitted, and they match
`SAFE_REQUEST_ID`, so an approval token supplied as `X-Request-Id` was accepted
verbatim and echoed.

Verified pre-fix: `resolveRequestId(approvalToken, [serviceToken, previousServiceToken])`
returns the approval token unchanged.

**Fix:** `genReqId` now uses `configuredSecrets(config)`.

**Threat model, stated honestly:** neither G1 nor G2 discloses a credential to
someone who did not already hold it. Both are credential-smear defects — a
legitimate client, proxy, or misconfiguration can push a high-value token into
response headers, problem bodies, and downstream log aggregation, where its
blast radius is much larger than the original request. That is exactly the risk
the pre-existing service-token handling already accepted as worth preventing;
the fix makes the treatment symmetric.

**Regression coverage:** `tests/httpSecretOutputBoundary.test.ts` — every
configured credential is covered by `configuredSecrets`; none can become a
request id (via the live app and directly at the `resolveRequestId` boundary);
none survives into a problem-details response; a benign request id is still
honoured.

## Validated as sound

| Boundary                            | Mechanism that makes it sound                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership — Convex                  | Every public `query`/`mutation` across all 30 functional modules calls `requireOwner(serviceToken)` before touching `ctx.db`, and every index read is `eq("ownerId", ownerId)`-scoped.                                                                                                                          |
| Ownership — Convex internal fns     | `internalQuery`/`internalMutation` accept a caller-supplied `ownerId` and are not client-callable; their only callers derive that id from a `requireOwner` result (e.g. `scheduleOmegaReceiptReconciliation`).                                                                                                  |
| Ownership — the one public `action` | `quoteFinalization.finalizeRevision` does not call `requireOwner` itself; it delegates to `quotePdfArtifacts.prepareFinalization` (internalQuery) and `commitFinalization` (internalMutation), both of which do. The authorizing query runs **before** any `ctx.storage.store()`. See the fragility note below. |
| Token comparison                    | Constant-time at all three auth boundaries: `serviceTokenGuard` (`timingSafeEqual` over SHA-256), `convex/authHelpers.requireOwner` (fixed-iteration accumulator, documented why `timingSafeEqual` is unavailable in the Convex runtime), `jarvis-console-01/gatewayAuth` (`timingSafeEqual` over SHA-256).     |
| Auth failure logging                | Rejections log the source IP and the fact of rejection only — never the candidate or the configured token (`serviceTokenGuard.ts`, `authHelpers.ts`, both with comments stating this is deliberate).                                                                                                            |
| Output — orchestration leases       | `publicStep()` strips `leaseToken` from every step document returned to a client; the lease token never crosses the boundary.                                                                                                                                                                                   |
| Output — console gateway            | 401/503 bodies carry a code and a static message; they never echo the candidate token.                                                                                                                                                                                                                          |
| Parsing — backup archives           | Strict closed parsers, 10 MiB bound on read, symlink refused, `O_NOFOLLOW`.                                                                                                                                                                                                                                     |
| Mutation — backup archive writes    | `0o600`, exclusive create (`wx`), temp-then-`link`, never overwrites an existing target.                                                                                                                                                                                                                        |
| Mutation — JSON stores              | Per-file `JsonFileLock` with PID/stale reclamation; temp-file-then-rename writes.                                                                                                                                                                                                                               |
| Dashboard rendering                 | No `innerHTML` / `dangerouslySetInnerHTML` / `document.write` / `eval` anywhere under `jarvis-console-01/`.                                                                                                                                                                                                     |
| Dashboard pre-auth surface          | Only the MCP `initialize` RPC bypasses the token check, which the protocol requires for capability negotiation; it returns no owner-scoped data. Sub-paths under `/mcp/` do not get the bypass (the method is only parsed for exactly `/mcp`), so they fall through to the token check.                         |

## Recorded coverage gaps (not remediated here)

1. **Fragile-by-delegation authorization.** `quoteFinalization.finalizeRevision`
   is a public action whose authorization exists only because it happens to call
   an authorizing internal query first. It is correct today; a future edit that
   stores before that call, or adds a branch skipping it, would silently drop
   authorization with no test failing. Worth an explicit assertion or an
   `requireOwner` call in the action itself. Not changed here — it touches the
   quote-delivery path, which is Codex's lane.
2. **Forgiving row parsing in the business record stores.** `normalize*` in the
   seven business `json*Store.ts` silently drops rows that fail validation
   instead of failing loudly. This is an integrity/availability concern already
   tracked under A2 (backup coverage) and A6 (persistence integrity), not a
   confidentiality one, and its fix belongs with the strict-reader work in A2.
3. **No authorization-evidence source for integrations.** Status can report that
   a tool is wired but not that anyone approved its use — see
   `docs/architecture/lifecycle-stages.md` and PR #486.
4. **Single-owner namespace.** `requireOwner` maps every valid service token to
   one constant `ownerId` (`jarvis-cli`). This prevents accidental cross-record
   collisions; it is **not** tenant isolation, and nothing in the data path
   should be read as providing it.
5. **Non-null assertion on a persisted field.** `snapshot.revision.fingerprint!`
   in `quoteFinalization.ts` throws rather than failing closed with a typed error
   if the field is absent. Robustness, upstream-validated, Codex's lane.

## Handoff

Items 1 and 5 above sit in the quote-delivery / PDF-artifact path and are handed
to Codex as shared security-report evidence rather than remediated here. Items 2
and 3 are bound to A2 and A7 respectively. Item 4 is a standing property to
restate, not a defect.
