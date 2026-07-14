# Controlled project-memory approval

Jarvis does not write model output directly into canonical project memory. Facts, assumptions,
measurements, and decisions move through a separate change-set state machine:

```text
proposed -> approved -> applied
    |
    +------> rejected
```

Each transition is authenticated, project-scoped, revision-checked, and audited. Applying a change
set writes every record, advances the project revision, marks the change set applied, and appends the
audit event in one Convex mutation. Any failure rolls back the complete transaction.

## Supported records

A change set may contain between 1 and 20 typed records:

- facts;
- assumptions;
- measurements;
- decisions.

Tasks, risks, events, constraints, and components are deliberately excluded from this first approval
slice. They require separate domain-specific validation before becoming eligible.

## Operator flow

### 1. Stage

```http
POST /api/v1/projects/{projectId}/memory-change-sets
Authorization: Bearer <JARVIS_SERVICE_TOKEN>
X-Request-Id: <opaque request ID>
Content-Type: application/json
```

```json
{
  "changeSetId": "crawler-bracket-measurements-001",
  "expectedRevision": 3,
  "records": [
    {
      "kind": "measurement",
      "recordId": "front-bracket-thickness",
      "name": "Front bracket thickness",
      "value": 6,
      "unit": "mm",
      "tolerance": "±0.2 mm",
      "source": "caliper measurement"
    }
  ],
  "rationale": "Record the verified bracket measurement before load-path analysis.",
  "proposedBy": "user"
}
```

Staging does not modify project records or the project revision. Reusing the same change-set ID with
identical contents replays the existing result; different contents fail with a conflict.

### 2. Inspect

```http
GET /api/v1/projects/{projectId}/memory-change-sets/{changeSetId}
GET /api/v1/projects/{projectId}/memory-change-sets?state=proposed&limit=25
```

A change-set ID is valid only under its original project path. Cross-project lookups return `404`.

### 3. Approve or reject

```http
POST /api/v1/projects/{projectId}/memory-change-sets/{changeSetId}/approve
Content-Type: application/json

{
  "expectedRevision": 3
}
```

```http
POST /api/v1/projects/{projectId}/memory-change-sets/{changeSetId}/reject
Content-Type: application/json

{
  "reason": "Measurement source needs verification."
}
```

Approval requires the project to remain at the proposal's base revision. A stale proposal fails with
`409` and must be restaged against current memory. Repeating the same approval or rejection is
idempotent; attempting to change an existing rejection reason fails.

### 4. Apply

```http
POST /api/v1/projects/{projectId}/memory-change-sets/{changeSetId}/apply
Content-Type: application/json

{
  "expectedRevision": 3
}
```

Only approved change sets can be applied. Apply is classified as destructive because it may replace
canonical records sharing the same record ID. Successful apply advances revision `3` to `4`.
Reapplying the same change set with its original base revision returns an idempotent result and does
not write another audit event.

## Validation and conflict rules

- project and change-set IDs are trimmed and non-empty;
- revisions are positive integers;
- fact confidence is finite and between `0` and `1`;
- measurement values are finite;
- inferred facts cannot claim confidence `1`;
- fact and decision timestamps are canonical UTC ISO date-times;
- decisions contain at most 50 rejected alternatives;
- record IDs are unique within a change set;
- measurement `name + unit` keys are unique within the project;
- measurement conflict validation is bounded and fails closed on oversized datasets;
- direct project-record mutations are internal-only.

## Failure semantics

| HTTP status | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `401`       | Missing or invalid Jarvis service token                                |
| `404`       | Project/change set does not exist under the requested project path     |
| `409`       | Revision, state, idempotency, or measurement conflict                  |
| `422`       | Invalid request contract                                               |
| `503`       | Convex memory approval is unavailable or the transaction failed safely |

Problem responses use the existing redacted `application/problem+json` envelope. Service tokens,
backend exception text, and internal state are never returned.

## Deployment boundary

The approval service is enabled only with `PERSISTENCE_PROVIDER=convex`, `CONVEX_URL`, and the
existing `JARVIS_SERVICE_TOKEN`. It is REST-only, not exposed through MCP, and does not authorise
production deployment. Convex production remains an explicit Benny approval checkpoint.
