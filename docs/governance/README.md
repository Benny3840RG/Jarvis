---
title: Jarvis Governance Set Index
status: frozen
baseline: v2.2
namespace: R-001–R-150
authority: navigational_only
last_reviewed: 2026-07-24
---

# Jarvis Governance Set Index

This document is the navigational front door to the Jarvis Totality governance set. It explains where controlled artifacts live and how they are used. It is not a source of normative authority.

## Authority order

1. [`requirements.yaml`](../requirements/requirements.yaml) — machine-readable canonical authority.
2. [`jarvis-requirements-v2.2.md`](../requirements/jarvis-requirements-v2.2.md) — controlled human-readable baseline.
3. [`state-glossary.md`](../requirements/state-glossary.md) — entity-specific state definitions.
4. [`requirements-matrix.md`](../traceability/requirements-matrix.md) — requirement lifecycle and traceability.
5. [`test-matrix.md`](../traceability/test-matrix.md) — requirement verification mapping.
6. [`evidence-matrix.md`](../traceability/evidence-matrix.md) — proof artifacts and validation outputs.
7. [`decision-register.md`](decision-register.md) — architecture decisions and rationale.
8. [`gap-register.md`](gap-register.md) — known omissions, debt and limitations.
9. [`risk-register.md`](risk-register.md) — operational and architectural risks.
10. [`handover-dossier.md`](handover-dossier.md) — operating guide and transfer pack.

Where artifacts conflict, the higher-ranked artifact governs. The conflict must be recorded in the gap register and corrected through controlled change. Lower-ranked artifacts must not be silently edited to conceal divergence.

## File index

| Order | File | Purpose | Owner |
|---:|---|---|---|
| 01 | `docs/requirements/requirements.yaml` | Canonical machine-readable requirements register. | Architecture owner |
| 02 | `docs/requirements/jarvis-requirements-v2.2.md` | Frozen human-readable requirements baseline. | Architecture owner |
| 03 | `docs/requirements/state-glossary.md` | Controlled state definitions and transition rules. | State owner |
| 04 | `docs/traceability/requirements-matrix.md` | Requirement status, lifecycle metadata and trace links. | Requirements owner |
| 05 | `docs/traceability/test-matrix.md` | Test coverage and negative-path mapping. | QA owner |
| 06 | `docs/traceability/evidence-matrix.md` | Evidence artifacts and verification records. | QA / Ops owner |
| 06A | `docs/traceability/action-family-registry.yaml` | Canonical action-family definitions and action-map generator input, subordinate to requirements and state authority. | Architecture / Policy owner |
| 07 | `docs/governance/decision-register.md` | Decisions, rationale, alternatives and supersession. | Architecture owner |
| 08 | `docs/governance/gap-register.md` | Deferred work, limitations and technical debt. | Product / Architecture owner |
| 09 | `docs/governance/risk-register.md` | Risks, controls and residual exposure. | Risk owner |
| 10 | `docs/governance/handover-dossier.md` | Operating guide, transfer conditions and boundaries. | Program owner |

Artifact ownership means responsibility for maintenance and accuracy. Approval authority remains governed by the applicable policy, requirement and deployment boundary.

## Action-family registry authority

The action-family registry is authoritative only for action-family definitions and generation of the operator action map. It is subordinate to `requirements.yaml`, the controlled requirements baseline and the state glossary. It must not redefine requirements, policy boundaries or entity-state semantics.

Every action family must bind a policy overlay. Explicit overrides are permitted only where the registry declares them and conflicting explicit values fail validation.

## Generated views

| Classification | File | Purpose |
|---|---|---|
| Generated view | `docs/traceability/action-map.generated.md` | Read-only operator view generated from the canonical action-family registry and its policy overlays. |

Generated views are non-authoritative and must never override source records.

## Read order for a new maintainer

1. Read the handover dossier to understand the operating model.
2. Read the canonical requirements YAML to understand authority.
3. Read the frozen requirements baseline to understand what the system must do.
4. Read the state glossary before changing workflow logic.
5. Read the action-family registry before changing operator actions or policy overlays.
6. Read the requirements matrix before changing scope.
7. Read the test matrix before changing behaviour.
8. Read the evidence matrix before claiming completion.
9. Read the decision, gap and risk registers before altering architecture.

## Change control rules

- Never rename, renumber, recycle or reassign requirement IDs.
- R-001–R-127 retain their original frozen meanings.
- R-128–R-143 are reserved for the four accepted architectural sections.
- R-144–R-150 govern revision and freeze control.
- Uppercase suffixes are allowed only for genuine subordinate refinements.
- Never let generated artifacts override the canonical source register.
- Never mark a requirement implemented without linked tests and evidence.
- Never allow the action map to drift from canonical requirements or the action-family registry.
- Never merge finalisation and external sending into one action family when their side-effect or approval models differ.
- Never ignore the gap, decision or risk registers when making changes.
- Never deploy to Convex production without Benny's explicit, production-specific approval.

## Stable references

- `[REQ-YAML]` `docs/requirements/requirements.yaml`
- `[REQ-MD]` `docs/requirements/jarvis-requirements-v2.2.md`
- `[STATE]` `docs/requirements/state-glossary.md`
- `[TRACE]` `docs/traceability/requirements-matrix.md`
- `[ACTION-REGISTRY]` `docs/traceability/action-family-registry.yaml`
- `[HANDOVER]` `docs/governance/handover-dossier.md`

## Operational principle

A maintainer must be able to determine, in order:

- what the system is;
- what it is allowed to do;
- what actions exist and which policy overlay governs each one;
- what it currently does;
- what has been tested;
- what proves it works;
- what remains unfinished; and
- what risks remain open.
