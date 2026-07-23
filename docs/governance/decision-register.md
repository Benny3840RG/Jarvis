# Decision Register

Controlled record of architectural and governance decisions, alternatives, rationale and supersession.

| Decision ID | Decision | Alternatives considered | Rationale | Date | Owner | Supersedes | Linked requirements |
|---|---|---|---|---|---|---|---|
| D-001 | Freeze the canonical requirement namespace at R-001–R-150. | Renumbering; reusing deleted IDs; maintaining separate architectural numbering. | Stable identifiers preserve traceability across implementation, tests and evidence. | 2026-07-24 | Architecture owner | None | R-144–R-150 |
| D-002 | Treat `requirements.yaml` as the highest machine-readable authority and the governance index as navigational only. | Markdown-only authority; equal authority across all artifacts. | Explicit precedence prevents silent divergence and allows deterministic validation. | 2026-07-24 | Architecture owner | None | R-144–R-150 |
| D-003 | Restrict Convex deployment to `dev:outgoing-ram-798` unless Benny gives explicit production-specific approval. | Implicit environment promotion; generic approval covering production. | Production deployment is a distinct high-impact action requiring an unambiguous authority boundary. | 2026-07-24 | Program owner | None | R-044–R-054, R-112–R-121 |

## Rules

- IDs use `D-###` and are never recycled.
- Superseded decisions remain visible and link to their replacement.
- Material architecture changes require a decision entry before implementation is accepted.
