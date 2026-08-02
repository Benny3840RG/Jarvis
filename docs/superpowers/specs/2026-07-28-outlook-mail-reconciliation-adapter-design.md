# Outlook Mail Reconciliation Adapter Design

**Date:** 2026-07-28  
**Status:** Approved for repository implementation  
**Scope:** Read-only Microsoft Graph mail reconciliation; development code only

## Objective

Add a provider-specific reconciliation adapter that can determine whether a previously registered Outlook draft-message send attempt became observable as sent, without adding any ability to create, modify, send, move, or delete mail.

## Verified baseline

- External reconciliation records already persist provider request and correlation references.
- `ReconciliationWorker` already owns leases, retries, terminal resolution, and escalation.
- `RuntimeReconciliationHost` already owns one bounded scheduler loop and fails closed when no adapter-bearing factory is supplied.
- Quote sending remains unreachable because `createQuoteEmailProviderFromEnv()` returns `null`.
- Maintained HTTP and preview runtimes do not currently compose a reconciliation adapter.
- Microsoft Graph `sendMail` and draft `send` return `202 Accepted`, which is not proof that processing completed.
- Outlook message IDs can change when a message moves unless requests use `Prefer: IdType="ImmutableId"`.

## Approaches considered

### 1. Immutable draft-message lookup — selected

The sending boundary, when separately implemented and approved, must create a draft using immutable IDs, persist that immutable message ID before the send attempt, then send the existing draft. Reconciliation performs a read-only lookup of that message.

This is the only approach that gives Jarvis a stable provider request reference without searching mailbox content or treating `202 Accepted` as success.

### 2. Direct `sendMail` plus Sent Items search

Rejected. `sendMail` returns no message object or stable request ID. Searching Sent Items by recipient, subject, custom header, or time window is eventually consistent and can match the wrong message.

### 3. Connector-owned reconciliation outside Jarvis

Rejected. ChatGPT's connected Outlook account is useful operator context, but it is not a runtime dependency Jarvis can own, test, deploy, or recover independently.

## Architecture

Create `OutlookMailReconciliationAdapter` under `typescript/src/reconciliation/`. It implements the existing `ProviderReconciliationAdapter` contract and depends on a narrow `OutlookMessageStatusClient`.

The client boundary exposes exactly one operation:

```ts
getMessageStatus(input: {
  mailbox: string;
  immutableMessageId: string;
  signal: AbortSignal;
}): Promise<OutlookMessageStatusResult>;
```

No client method may create, update, send, move, delete, or search messages. The adapter accepts only the exact provider name `microsoft-graph-mail-v1`.

A fetch-based client may be constructed only through explicit dependency injection. It receives an access-token supplier rather than storing a token. This tranche does not implement OAuth, refresh-token storage, an email provider, or maintained-runtime activation.

## Provider reference contract

For `provider=microsoft-graph-mail-v1`:

- `providerRequestId` is the Outlook immutable draft message ID.
- `providerCorrelationId` remains the Jarvis-owned external-attempt correlation reference.
- Empty, whitespace-only, or control-character references are rejected without issuing a network request.
- IDs are URL path segments and must be encoded with `encodeURIComponent`.
- Every Graph message request includes `Prefer: IdType="ImmutableId"`.
- The response selects only `id,isDraft,sentDateTime,internetMessageId`.

## Result mapping

| Observation | Reconciliation result |
| --- | --- |
| HTTP 200, matching ID, `isDraft=false`, valid `sentDateTime` | `succeeded` with a SHA-256 digest of canonical non-secret status fields |
| HTTP 200, `isDraft=true` | `unresolved: outlook-message-still-draft` |
| HTTP 200 with malformed or mismatched data | `unresolved: outlook-message-status-invalid` |
| HTTP 404 or 410 | `unresolved: outlook-message-not-observable` |
| HTTP 429 | `unresolved: outlook-graph-throttled`, using a bounded `Retry-After` delay when valid |
| HTTP 500, 503, or 504 | `unresolved: outlook-graph-unavailable` |
| HTTP 401 or 403 | throw a redacted `outlook-graph-authorization-failed` error for worker retry/escalation |
| Other 4xx | `unresolved: outlook-graph-request-rejected` |
| Abort | throw a redacted abort error; the worker retains ownership of cancellation handling |
| Network or parse failure | throw a stable redacted error; never include tokens, response bodies, mailbox names, message IDs, or Graph messages |

A missing message is never terminal failure: absence cannot prove that the original send failed. Likewise, Graph availability or authentication failure never changes a quote delivery into a provider failure.

## Security and authority boundary

- No `POST`, `PATCH`, `PUT`, or `DELETE` request exists in this tranche.
- No `Mail.Send` permission is required or documented.
- No Outlook access token is read directly from `process.env`.
- Tokens, mailbox names, message IDs, Internet message IDs, response bodies, and Graph request identifiers are excluded from errors and health.
- Redirects are rejected.
- Only `https://graph.microsoft.com/v1.0` is accepted as the default origin; tests may inject a transport without opening sockets.
- Quote send, `AM-013`, `WF-QUOTE-001`, and maintained-runtime reconciliation remain inactive.
- No live Outlook request, Convex deployment, Manufact deployment, or production deployment is performed.

## Retry behaviour

`Retry-After` is accepted only as an integer number of seconds from 1 through 300 and converted to milliseconds. Invalid or out-of-range values are ignored so the existing worker backoff applies. This keeps provider advice bounded by the worker's configured maximum retry delay.

## Testing

Test-first coverage must prove:

- a sent immutable message resolves successfully;
- a draft remains unresolved;
- absence remains unresolved;
- throttling honours a bounded integer `Retry-After`;
- unavailable and rejected responses are classified without leaking response bodies;
- authorization and network failures throw only stable redacted codes;
- malformed JSON, mismatched IDs, invalid dates, and invalid references never resolve success;
- URL encoding, the immutable-ID preference, narrow `$select`, GET-only method, redirect rejection, and abort propagation;
- no test or runtime path can call a mail-write operation;
- existing worker, runtime-host, quote allowlist, full TypeScript, Console, OpenAPI, and automation-policy gates remain green.

## Documentation

Update deployment guidance to describe the adapter as implemented but uncomposed. Document the immutable draft-message reference contract as a prerequisite for any future Outlook send-provider design. Do not add token setup or activation instructions.

## Acceptance criteria

- The adapter can reconcile a previously registered immutable Outlook message reference through read-only Graph calls.
- It never treats `202 Accepted`, missing mail, outages, or authorization failures as proof of success or provider failure.
- Its errors and digests contain no secret or provider-identifying payload.
- Existing generic worker retry and escalation semantics remain authoritative.
- No email or calendar action becomes reachable.
- Maintained runtimes remain disabled and fail closed until a separate OAuth and provider-activation design is explicitly approved.
