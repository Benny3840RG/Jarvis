# Scaffold and runtime boundaries

Jarvis contains one maintained application and several retained prototypes or generated development aids. This document prevents those surfaces from being mistaken for production capability.

## Maintained runtime

The maintained application is the TypeScript CLI under `typescript/`.

Its supported durable surface is:

- explicit task and reminder commands in `src/cli.ts`
- JSON and Convex persistence selected explicitly by configuration
- reminder due parsing and validation
- provider-neutral backup, verification, and empty-target restore
- service-token-protected, owner-scoped Convex functions

Changes to this surface require the full TypeScript gate suite. Convex changes also require development-deployment verification before the work is complete.

## Retained TypeScript prototypes

The conversational routing, workshop/business/home domain engines, orchestration graph, workflow generator, learning engine, proactive summaries, context memory, and personal-traits responses are prototype modules.

They are retained because the current CLI wiring test exercises the original planning flow, but they are not durable product features:

- their generated workshop, business, and home records are synthetic and are not written as tasks
- their learning and context memory are process-local and disappear on restart
- their output is deterministic scaffolding, not an AI model response
- they must not invent calendar commitments; the planning sample therefore carries no due date
- they must not be treated as TBTB business logic or expanded into a second business system

A later feature may promote a prototype only through a focused requirement, durable contract, tests, and the normal branch/PR process.

## Legacy Python prototype

The root `pyproject.toml` and `src/jarvis/` package are the original local notes/checklist prototype.

It is not part of the maintained TypeScript/Convex runtime:

- it stores notes separately in `~/.jarvis/notes.jsonl`
- it does not use the JSON or Convex persistence providers
- it is not exercised by the TypeScript CI workflow
- new Jarvis development must not add features to it

It remains only so existing local notes can be inspected or migrated. Once any required notes are migrated, it can be removed in a dedicated cleanup PR.

## Generated Convex development aids

The `typescript/.agents/`, `typescript/.claude/`, and `typescript/convex/_generated/` trees come from Convex tooling. They contain development guidance or generated API support; they are not Jarvis product modules.

Do not hand-edit generated Convex API files. Regenerate them through the pinned Convex workflow when contracts change.

## Dates in examples and tests

Production runtime code must not contain a sample calendar date that can become a false commitment.

Fixed dates are allowed in tests when they are deliberate fixtures for parsing, daylight-saving, migration, backup, or restore behaviour. Documentation uses generated backup filenames so copy-paste examples do not keep presenting an old date as current.
