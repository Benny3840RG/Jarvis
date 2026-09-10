# Development Live Work

`get_development_live_work` and `show_jarvis_dashboard.structuredContent.liveWork`
read the same authenticated `GET /api/v1/development/live-work` projection.
They do not mutate missions, grant approval, or commit completion.

- Unconfigured JSON persistence: HTTP 200 with `status: unavailable` and
  `Development Live Work requires configured Convex persistence.`
- Available Convex with no non-terminal subject: `status: available`, `pipeline: null`;
  the dashboard displays `NO MISSION IN FLIGHT`.
- Exactly one active subject: its persisted Development state controls the rail.
  Repair and indeterminate states remain explicit. Subject version, repository,
  branch, receipt-bound PR/SHA identity, orchestration binding, lease information and recent event/evidence IDs are projected
  only when recorded. Lease tokens and unknown row fields are excluded.
- Multiple active subjects: bounded unavailable response explaining ambiguity.
  Recency does not confer current-mission authority. Exceeding a safe query or
  validation bound also fails unavailable; it never fabricates idle.
- COMPLETE, FAILED, ABORTED and CONTRADICTED subjects are terminal and never
  selected as current work. MERGED remains current until authoritative completion.

ΩΣ readiness reuses the completion transition's durable proof/evidence/contradiction
and external-effect derivation and `evaluateOmegaCompletion`. It never reads
mirrored criterion status as completion evidence. The existing transition accepts
residual uncertainty from its caller but does not persist it, so the query reports
`residual-uncertainty-not-recorded`. A green synthetic readiness fixture tests the
rendering contract only; it is not live readiness evidence. No uncertainty value
or approval is invented by the read model.

`MERGED — ΩΣ READY` is different from `COMPLETE`. Only the existing authoritative
ΩΣ transition can persist Development COMPLETE. After that transition, the current
mission query becomes idle (or returns another uniquely active mission).
