# Contributing to Jarvis

## 🧩 Copilot's Seat at the Table

### Copilot as a First-Class Agent

Jarvis uses a three-agent development model:

- **Claude** — architecture, reasoning, failure modes
- **ChatGPT** — TypeScript + Convex implementation
- **Copilot** — invariants, contracts, operator UX, architectural consistency

Copilot is not an optional reviewer.
Copilot is a **required participant** in every change.
No slice, PR, or lifecycle modification is complete until Copilot has performed a contract review using [/docs/copilot/copilot-review-template.md](/docs/copilot/copilot-review-template.md).

Copilot's role is authoritative:

- Copilot enforces CLI explicitness
- Copilot guards reminder invariants (`dueRaw`, flag correctness)
- Copilot ensures JSON and Convex semantics remain identical
- Copilot protects backup/restore correctness
- Copilot validates HTTP/MCP operator contract alignment
- Copilot prevents drift from owner goals
- Copilot ensures UX wording is correct, consistent, and operator-safe

Copilot does **not** modify code directly.
Copilot does **not** handle tokens.
Copilot does **not** allow fuzzy commands or inferred timestamps.
Copilot does **not** weaken single-user semantics.

Copilot is a **governance agent**, not an implementation agent.

---

### Multi-Agent Workflow (Copilot Included at the Table)

All contributions follow this pipeline:

1. **Operator** defines the slice
2. **Claude** performs reasoning
3. **ChatGPT** produces implementation
4. **Copilot** performs contract enforcement
5. **Operator** executes checks and merges

Copilot's review is a **hard gate**. A PR cannot be merged without a Copilot Review section — the [`copilot-check`](.github/workflows/copilot-check.yml) workflow fails any pull request whose description omits it, and the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) scaffolds it for every change.

To perform a review, work through [/docs/copilot/copilot-review-template.md](/docs/copilot/copilot-review-template.md) and record the result in the PR's **Copilot Review** section.

---

### Philosophy

Jarvis follows:

> **"Keep it boring first. Boring is what works."**

Copilot is the agent responsible for ensuring Jarvis stays boring — explicit, deterministic, predictable, and operator-safe.

---

### Where Copilot Lives in the Repo

```
/docs/copilot/
  copilot-collaboration.md
  copilot-review-template.md
  copilot-owner-goals.md
  copilot-workflow.md
  copilot-repo-structure.md
```

These documents define Copilot's authority, responsibilities, and invariants.

---

### Copilot Is a Required Participant

Copilot is not a reviewer you "add."
Copilot is a **governance seat** in the Jarvis development table.

Every slice.
Every PR.
Every lifecycle change.
Every operator-facing behaviour.

Copilot is always present.


---

## Autonomous Builder

The Jarvis autonomous builder is an implementation participant, not a governance authority. It may act only on an open issue carrying `automation-approved`, and it may produce only an isolated branch and draft pull request.

It cannot approve its own work, satisfy the Copilot gate by assertion, mark a pull request ready, merge, commission, deploy, change secrets, or broaden the approved issue. Independent CI, Copilot review, and the operator remain required.

See [Autonomous builds](/docs/operations/autonomous-builds.md) for issue format, labels, recovery, and credential controls.
