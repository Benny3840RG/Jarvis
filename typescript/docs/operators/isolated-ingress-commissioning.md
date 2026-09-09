# Isolated ingress & idempotency commissioning (#324)

The bounded orchestration runner and the Convex-backed durable run-state boundary
are composed and tested, but wired into no ingress path. This bootstrap is the
**smallest robust slice** that proves authenticated trigger ingress + durable
idempotency under delivery races: one private, OIDC-authenticated probe delivery,
raced through two local processes against the **development** Convex backend,
executing one read-only step and no business action.

**Merging the bootstrap PR clears no live gate.** Only the recorded
development-backend drill described below can clear the bounded
ingress/idempotency acceptance item. #324 stays open for remote gateway
commissioning, deployed recovery/rollback, provider behaviour and production
approval.

## What the bootstrap is

`npm run commission:isolated-ingress` starts a **loopback** HTTP listener with
`authMode` forced to `oidc` (the production `resolveHttpAppConfig` still selects
`service-token` on a loopback host — it is unchanged; the bootstrap assembles the
OIDC config explicitly). The only route is:

```
POST http://127.0.0.1:<port>/commissioning/v1/isolated-ingress
Authorization: Bearer <OIDC access token>
Idempotency-Key: <8–128 safe chars>
X-Commissioning-Attempt: first-attempt | retry     (optional, default first-attempt)
Content-Type: application/json

{ "nonce": "<stable per logical delivery>", "payload": { ...primitives... } }
```

The composition:

- authenticates with the production `ServiceTokenGuard` in `oidc` mode — a
  forged/invalid token or a wrong `sub` is rejected **before** any admission
  call;
- derives the durable worker id from the verified principal
  (`oidc:sha256(iss\0aud\0sub)`) — the caller cannot supply it;
- establishes **authority from policy** (`T1`), never from the request; the body
  schema rejects an `authority` field outright;
- hashes the _validated canonical_ body for `requestFingerprint` — a whitespace
  or JSON key-order change replays, any semantic change conflicts — and retains
  the secret-free canonical pre-image in evidence;
- runs a one-node read-only `commissioningProbe` graph through
  `ConvexOrchestrationRunner` — admission (`beginRun`) is the only gate;
- initialises **no** persistence, store, provider or business adapter.

### Response mapping

| HTTP | Disposition          | Meaning                                                                                                                                                    |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 201  | `created-complete`   | new canonical run; probe executed once                                                                                                                     |
| 200  | `terminal-replay`    | canonical run already terminal; not re-executed                                                                                                            |
| 202  | `nonterminal-replay` | canonical run still in progress; not re-executed                                                                                                           |
| 409  | `conflict`           | same key, semantically different request                                                                                                                   |
| 503  | `admission-unknown`  | backend unavailable **or** admission timed out — the outcome is unknown; retry with the **same** Idempotency-Key, never a fresh key, never local execution |

## Prerequisites for the recorded drill

1. An **approved development** `JARVIS_OIDC_*` configuration (issuer, audience,
   JWKS URL, subject).
2. A **deployed development** backend: `CONVEX_URL`, `CONVEX_DEPLOYMENT` and a
   matching `JARVIS_SERVICE_TOKEN`. Record the deployed revision.
3. `JARVIS_HTTP_HOST` unset or a loopback address (the bootstrap refuses any
   other host).
4. A `JARVIS_COMMISSIONING_CAMPAIGN_ID` for the drill (printed on start if unset).
5. `PERSISTENCE_PROVIDER` is irrelevant to this bootstrap — it wires no core
   provider — but keep it `json`/unset for a normal dev environment.

The authorised development database is **persistent, not disposable**. Every drill
run writes real `orchestrationRuns` / `orchestrationSteps` rows under the single
`jarvis-cli` owner; the campaign id is the only tenant-ish boundary and it
prevents accidental collision, not isolation.

## Running the drill

1. Start the listener in process A: `npm run commission:isolated-ingress`.
2. From two processes, send the **same** Idempotency-Key and the **same**
   semantic body (same `nonce`, same `payload`) — 20 total logical deliveries,
   plus the negative checks:
   - a token with a bad signature / wrong `sub` → 401 / 403;
   - the same key with a changed `nonce` or `payload` value → 409;
   - a redelivery after the run is terminal → 200;
   - the backend stopped → 503, then restarted and retried with the same key.
3. Record, from the listener's evidence log (`{"kind":"delivery",...}` /
   `{"kind":"step-outcome",...}` lines, all secret-free):
   - **first-attempt outcomes separately** from bounded retries;
   - separate counts for immediate replays, explicitly-classified transient
     failures, and retries (`X-Commissioning-Attempt: retry`).

### Pass criteria

- Exactly **one** `created-complete` and exactly **one** executor entry (one
  `markStepRunning`) across both processes.
- Every other logical delivery **eventually resolves to the same canonical run
  id** within the fixed retry budget (a transient failure may be retried with the
  same key and semantic payload; a `503` admission-unknown is retried, never
  treated as permission to execute or to mint a new key).
- No unexplained errors, missing outcomes or exhausted retries.
- The negative checks each produce their expected non-2xx.

A timeout is an **unknown admission outcome**, not a licence to run the step
locally or start a fresh key.

## Cleanup

```
npm run commission:isolated-ingress -- cleanup <campaignId> <runId> [runId...]
```

`purgeCommissioningRun` verifies, per run, that it carries the fixed commissioning
policy version, the `isolated-ingress-probe` trigger kind, and the exact campaign
id, before deleting its steps, reconciliations and the run. A run that fails any
check aborts the whole transaction — nothing is deleted. Use only the run ids the
drill recorded.
