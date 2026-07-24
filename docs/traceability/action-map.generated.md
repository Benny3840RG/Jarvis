<!-- GENERATED FILE: do not edit manually. -->
# Jarvis Action Map

Generated from `docs/traceability/action-family-registry.yaml`. This view is non-authoritative.

| ID | Action | Status | Domain | Capability | Overlay | Effect | Approval | External side effect | Reconciliation |
|---|---|---|---|---|---|---|---|---|---|
| AM-012 | Finalize quote | planned | business | quoting | internal_mutation | mutate | never | false | false |
| AM-013 | Send quote | planned | business | quoting | send_with_approval | send | always | true | true |
| AM-003 | Create note | planned | business, home, workshop, shared | notes | internal_mutation | mutate | never | false | false |

## Workflows

- **WF-QUOTE-001 — Finalize and send quote:** AM-012 → AM-013
