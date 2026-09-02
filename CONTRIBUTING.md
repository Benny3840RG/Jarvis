# Contributing to Jarvis

## Development authority

Jarvis may use Claude, ChatGPT, Copilot or another suitable model to reason,
implement or critique a change. Model output is advisory evidence. A model does
not create authority, approve its own work, satisfy deterministic gates or
authorise a merge.

The permanent boundary is:

> MODEL THINKS → JARVIS GOVERNS → EXECUTION ACTS → EVIDENCE OBSERVES → ΩΣ COMPLETES

Repository contracts, tests, CI, current approvals and trusted reviewer identity
remain authoritative.

## Contribution workflow

1. The operator or approved issue defines a bounded slice.
2. A capable model may analyse architecture, failure modes and contract impact.
3. Implementation follows test-first development and preserves existing
   authority paths.
4. Required CI checks the exact candidate SHA.
5. The PR records evidence relevant to the changed files.
6. An independent authorised reviewer evaluates the diff and evidence.
7. Merge proceeds only after repository policy grants authority.

No particular model is mandatory for every change. Use the lowest-cost capable
model, escalating for architecture, security, contradiction or repeated
verification failure.

## PR evidence

The [PR Evidence template](/docs/copilot/pr-evidence-template.md) covers:

- CLI Contract
- Persistence Providers
- Backup / Restore
- HTTP / MCP
- Documentation

Include only headings relevant to the changed paths. A concrete finding or
`N/A — <reason>` is acceptable. Required CI supplies test and check results
automatically, so do not manually copy test counts into the PR description.

The [PR Evidence Check](.github/workflows/copilot-check.yml) enforces applicable
evidence lines and companion tests for TypeScript source changes. It does not
pretend that filling in a template is an independent code review.

## Model review

Copilot or another model may review:

- CLI explicitness and operator behaviour;
- JSON/Convex and persistence semantics;
- backup and restore behaviour;
- HTTP/MCP contract alignment;
- documentation consistency;
- concurrency, security and failure modes.

Useful findings belong in the PR discussion or evidence package. Model approval
never replaces independent reviewer authority.

## Autonomous builder

The Jarvis autonomous builder is an implementation participant, not a governance
authority. It may act only on an open issue carrying `automation-approved` and
may produce only an isolated branch and draft pull request.

It cannot approve its own work, mark a pull request ready, merge, commission,
deploy, change secrets or broaden the approved issue. Independent CI, relevant
PR evidence and an authorised reviewer remain required.

See [Autonomous builds](/docs/operations/autonomous-builds.md) for issue format,
labels, recovery and credential controls.
