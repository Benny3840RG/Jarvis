# Decision Register

Controlled record of architectural and governance decisions, alternatives, rationale and supersession.

| Decision ID | Decision | Alternatives considered | Rationale | Date | Owner | Supersedes | Linked requirements |
|---|---|---|---|---|---|---|---|
| D-001 | Freeze the canonical requirement namespace at R-001–R-150. | Renumbering; reusing deleted IDs; maintaining separate architectural numbering. | Stable identifiers preserve traceability across implementation, tests and evidence. | 2026-07-24 | Architecture owner | None | R-144–R-150 |
| D-002 | Treat `requirements.yaml` as the highest machine-readable authority and the governance index as navigational only. | Markdown-only authority; equal authority across all artifacts. | Explicit precedence prevents silent divergence and allows deterministic validation. | 2026-07-24 | Architecture owner | None | R-144–R-150 |
| D-003 | Restrict Convex deployment to `dev:outgoing-ram-798` unless Benny gives explicit production-specific approval. | Implicit environment promotion; generic approval covering production. | Production deployment is a distinct high-impact action requiring an unambiguous authority boundary. | 2026-07-24 | Program owner | None | R-044–R-054, R-112–R-121 |
| D-004 | Make the action-family registry authoritative only for action definitions and action-map generation, subordinate to requirements and state authority. Every family must bind a controlled policy overlay. | Make the generated action map authoritative; duplicate policy fields without inheritance rules; define actions only in prose. | Preserves normative precedence while providing a machine-valid operational contract. | 2026-07-24 | Architecture / Policy owner | None | R-034–R-038C, R-055–R-062, R-144–R-150 |
| D-005 | Split quote finalisation and quote sending into AM-012 and AM-013, with WF-QUOTE-001 composing them. | Keep one action that both finalises internal state and sends externally. | Internal mutation and external delivery have materially different approval, idempotency and reconciliation models. | 2026-07-24 | Architecture / Quoting owner | None | R-039–R-054, R-073–R-076, R-091–R-098C, R-141–R-143 |

## Rules

- IDs use `D-###` and are never recycled.
- Superseded decisions remain visible and link to their replacement.
- Material architecture changes require a decision entry before implementation is accepted.
