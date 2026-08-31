# JARVIS_ARCHITECTURE

Status: canonical architecture
Phase: governed development substrate first

## Purpose

Jarvis is a persistent governed intelligence system, not an LLM application. Models are replaceable cognitive processors inside a system that owns identity, authority, state, evidence, execution, reconciliation, and completion.

Jarvis must permanently distinguish:

- what a model proposes;
- what Jarvis currently believes;
- what authoritative records state;
- what evidence proves;
- what Jarvis is authorised to do;
- what actually happened in the external world.

No single model response may collapse those categories.

## Existing foundations retained

The existing implementation remains authoritative where already established, including:

- Convex persistence;
- ToolActions and the external-effect boundary;
- approval and revocation lifecycle;
- single-use execution claims;
- leases, retries, and idempotency;
- provider-neutral execution;
- durable receipts and reconciliation;
- indeterminate outcomes;
- ΩΣ completion integrity and proof/evidence authority;
- append-only contradiction resolution;
- governed memory/knowledge change paths;
- HUD/Totality as projection and control surface, not authority.

This architecture extends those foundations. It does not replace them.

## System planes

### Control Plane
Owns identity, policy, capability envelopes, budgets, approvals, escalation, and authority decisions. It decides whether a proposal is admissible; it does not manufacture evidence or completion.

### Cognitive Kernel
Coordinates interpretation, decomposition, planning, critique, uncertainty analysis, simulation, and model arbitration. Model output is always proposal-level unless promoted through deterministic gates.

### World Model
Represents entities, relationships, temporal state, claims, provenance, evidence links, contradictions, and uncertainty. Materialised current-state projections are permitted, but authoritative transition history must remain auditable and replayable.

### Mission Engine
Preserves durable intent using Mission -> Strategy -> Plan -> Work Package -> Action -> Tool Invocation. Plans may change without rewriting the mission objective or its authority envelope.

### Execution Fabric
Maps stable Jarvis capabilities onto native functions, APIs, MCP providers, browser/computer interfaces, code execution, and future physical interfaces. Providers are replaceable adapters; Jarvis capability semantics remain stable.

### Evidence and Truth Plane
Owns observations, receipts, verification results, contradiction records, reconciliation state, and ΩΣ completion evaluation. Provider success is evidence, not proof of mission completion.

### Metacognitive Controller
Monitors stale plans, repeated failure, unresolved uncertainty, resource waste, evidence quality, and escalation conditions.

### Opportunity Engine
Ranks candidate interventions by expected value, urgency, confidence, mission relevance, execution cost, risk, and operator interruption cost.

### Governed Learning
Compares expected versus observed outcomes and may propose knowledge changes. Learning never self-authorises promotion into governing knowledge.

## Deterministic admissibility

LLMs may propose:

- plans;
- code;
- explanations;
- state-change requests;
- tool arguments;
- hypotheses;
- candidate knowledge.

Deterministic services decide whether those proposals are admissible. Policy evaluation, schema checks, budgets, authority envelopes, idempotency, evidence requirements, legal transitions, and completion gates are not delegated to free-form model judgement where code can decide them.

## State and history

Authoritative transition/event history is append-only. Current-state projections may be mutable and materialised for performance, provided:

1. projection writes are produced only by approved deterministic reducers;
2. reducer versions are recorded;
3. projections are rebuildable from authoritative history plus the reducer version;
4. projection divergence cannot bypass an authority or completion gate.

## Development as the first proving ground

Phase 1 proves the architecture in one bounded vertical slice:

GitHub issue -> validated specification -> DevelopmentMission -> claimed worker -> build -> verification -> repair if required -> independent review -> merge authorisation -> merged -> post-merge observation -> ΩΣ completion.

The proving criteria are governance properties, not feature count:

- illegal transitions fail closed;
- workers cannot expand authority;
- stale leases cannot commit work;
- operation failures do not masquerade as transition success;
- ambiguous external outcomes remain indeterminate;
- review failure creates durable repair work;
- merge success does not imply mission completion;
- only ΩΣ may commit COMPLETE;
- every material decision is causally explainable.

## Expansion order

After the development vertical slice is proven, reuse the same mechanics for operational missions, business workflows, broader world-model projections, opportunity generation, governed learning, and physical-world capabilities. Generalisation must follow evidence from the proving slice, not precede it.
