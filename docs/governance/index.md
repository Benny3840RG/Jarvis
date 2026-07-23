```yaml
document:
  title: Jarvis Governance Set Index
  status: frozen
  baseline: v2.2
  namespace: R-001–R-150
  authority: navigational_only
  last_reviewed: "2026-07-23"
```

This index is **navigational only**. It does not create requirements, redefine terms, or grant
approval authority on its own — it states where authority actually lives and, when two artifacts
disagree, which one governs until the conflict is resolved through controlled change.

## Rank order

Artifacts are listed highest-authority first. When two artifacts conflict on a normative
question — what the system is required to do — the higher-ranked one governs, the conflict is
recorded in the gap register, and the lower-ranked artifact is corrected. It is never silently
edited to hide the divergence.

1. **`[REQ-MD]` `docs/requirements/jarvis-requirements-v2.2.md`**
   The frozen master specification. Prose intent, definitions, and rationale live here. This is
   the senior normative artifact in the set.

2. **`[REQ-YAML]` `docs/requirements/requirements.yaml`**
   The machine-readable register of the same frozen baseline — IDs, sections, lifecycle
   metadata. Must always agree with REQ-MD. A divergence between the two is a REQ-YAML defect,
   corrected to match the prose, not a license to reinterpret it.

3. **`[STATE]` `docs/requirements/state-glossary.md`**
   Defines the vocabulary REQ-MD and REQ-YAML use (lifecycle states, etc.). Subordinate to both:
   if a glossary entry doesn't match how a term is actually used in the requirements, that's a
   glossary defect, not grounds for reinterpreting the requirement.

4. **`docs/architecture/*.md`**
   Architecture and design specs (`totality-system-spec.md`, `ownership-and-concurrency.md`,
   `persistence-modules.md`, `reminder-due-model.md`, `scaffold-and-runtime-boundaries.md`, and
   related). Describe how the system is built to satisfy the frozen requirements above. Senior
   to everything below because they encode binding structural constraints — e.g. the single-owner
   boundary, the deliberate absence of an execute route until an allowlist exists — that operator
   docs and traceability views must not contradict.

5. **`docs/operators/*.md`**
   Operator- and API-facing contracts (`tool-action-approval.md`, `http-api.md`,
   `memory-approval.md`, `totality-http.md`, `chatgpt-preview.md`). Describe the behavior exposed
   to callers. Must conform to the architecture tier above and the requirements; these are where
   day-to-day operational claims live, and where drift is most likely to be noticed first (see
   `tool-action-approval.md`'s execution-boundary history as the working example).

6. **`[TRACE]` `docs/traceability/requirements-matrix.md`, `test-matrix.md`, `evidence-matrix.md`**
   Traceability views mapping requirements to tests and evidence. Purely derivative of tiers 1–5:
   a conflict between a matrix and its source is a traceability defect, corrected to match,
   never grounds for reinterpreting the source it's supposed to reflect.

7. **`docs/operations/*.md`, `docs/deployment.md`, `docs/failure-behaviour.md`**
   Process and tooling docs (branch protection, CI health, preview features, deployment,
   failure behaviour). Operational detail, not product-behavior authority — these describe how
   the team runs things, not what the system is required to do.

8. **`[HANDOVER]` `docs/governance/handover-dossier.md`** *(not yet created)*
   A point-in-time onboarding/handover snapshot. Explicitly a snapshot: the moment it goes
   stale, everything above it in this list governs instead. Never treat it as current-state
   authority without checking it against tier 1 first.

9. **Generated views** — `[ACTION-MAP]` `docs/traceability/action-map.generated.md`
   *(not yet created)*, and any other auto-generated artifact.
   Read-only by construction and non-authoritative by design. Regenerate to resolve a conflict;
   never hand-edit a generated file to make it agree with something else.

### Evidentiary authority (orthogonal to the rank order above)

The rank order resolves *normative* conflicts — what the system is required to do. It does not
decide whether a requirement's `implemented` / `partial` / `planned` / `deferred` / `rejected`
lifecycle status is honest. For that, the actual code and tests under `typescript/` are the sole
authority: if REQ-YAML claims a requirement is `implemented` and the code doesn't satisfy it,
that is a REQ-YAML defect to correct via controlled change, not something the code or its tests
should be bent to match after the fact. This mirrors the Ownership rule below — code authorship
and requirements authorship are different responsibilities, and neither should quietly overrule
the other's domain.

## Conflict rule

Where artifacts conflict, the higher-ranked artifact governs. The conflict must be recorded in
the gap register and corrected through controlled change; lower-ranked artifacts must not be
silently edited to conceal divergence.

## Ownership rule

Artifact ownership means responsibility for maintenance and accuracy. Approval authority remains
governed by the applicable policy, requirement, and deployment boundary.

## Generated action map

| Classification | File | Purpose |
| --- | --- | --- |
| Generated view | `docs/traceability/action-map.generated.md` | Read-only operator view generated from canonical requirements and lifecycle metadata. |

## Stable reference labels

Use these labels instead of ad hoc citations:

- `[REQ-YAML]` `docs/requirements/requirements.yaml`
- `[REQ-MD]` `docs/requirements/jarvis-requirements-v2.2.md`
- `[STATE]` `docs/requirements/state-glossary.md`
- `[TRACE]` `docs/traceability/requirements-matrix.md`
- `[HANDOVER]` `docs/governance/handover-dossier.md`
- `[ACTION-MAP]` `docs/traceability/action-map.generated.md`

## Formal disposition

Accepted, subject to citation resolution and the conflict-handling language above. This index
remains **navigational only**; it is not itself a source of normative authority.
