# Copilot-Integrated Repo Structure

This is the intended home for the Copilot governance layer and the file paths
the collaboration workflow expects. Paths shown at repo root (`docs/`,
`.github/`, `CONTRIBUTING.md`) live at the repository root; the maintained
application lives under `typescript/`.

```
Jarvis/
├── docs/
│   ├── architecture/
│   ├── runbooks/            (see typescript/docs/operators for live runbooks)
│   └── copilot/
│       ├── copilot-collaboration.md
│       ├── copilot-review-template.md
│       ├── copilot-owner-goals.md
│       ├── copilot-workflow.md
│       └── copilot-repo-structure.md
│
├── .github/
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── ISSUE_TEMPLATE/
│   │   └── slice.md
│   └── workflows/
│       └── copilot-check.yml
│
├── CONTRIBUTING.md
│
└── typescript/              (maintained CLI / Convex / HTTP / MCP application)
    ├── src/
    ├── convex/
    ├── tests/
    ├── docs/
    ├── openapi/
    └── package.json
```

## Governance file roles

| Path                                        | Role                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `docs/copilot/copilot-collaboration.md`     | What Copilot is responsible for and what it must not do.             |
| `docs/copilot/copilot-review-template.md`   | The review checklist Copilot applies to every PR.                    |
| `docs/copilot/copilot-owner-goals.md`       | Owner deliverables, non-goals, and the collaboration model.          |
| `docs/copilot/copilot-workflow.md`          | The step-by-step operator → Claude → ChatGPT → Copilot loop.         |
| `.github/PULL_REQUEST_TEMPLATE.md`          | PR body scaffold; requires a Copilot Review section.                 |
| `.github/ISSUE_TEMPLATE/slice.md`           | Slice-definition issue scaffold.                                     |
| `.github/workflows/copilot-check.yml`       | CI check that a PR body includes a Copilot Review section.           |
| `CONTRIBUTING.md`                           | Entry point summarising the Copilot workflow.                        |
