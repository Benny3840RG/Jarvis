# Jarvis

A small local command-line assistant scaffold for Benny's workflow.

This repo is intentionally simple: no API keys, no cloud lock-in, and no background magic. It gives you a working Python entry point that can be expanded into reminders, job notes, quoting helpers, and daily trade checklists.

## Quick start

```bash
cd Jarvis
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
jarvis status
jarvis checklist
jarvis note "Measure Kirsten hedge access and green waste volume"
jarvis notes
```

## Commands

| Command | What it does |
|---|---|
| `jarvis status` | Checks the app can run and shows storage path. |
| `jarvis checklist` | Prints a practical daily trade/business checklist. |
| `jarvis note "text"` | Saves a timestamped local note. |
| `jarvis notes` | Lists saved notes. |

## Storage

Local notes are stored in:

```text
~/.jarvis/notes.jsonl
```

## Next sensible upgrades

- Quote helper using The Beez Treez rates.
- Job checklist templates.
- Client follow-up tracker.
- Calendar/email integration only after the basics are stable.

Keep it boring first. Boring is what works.
Add Convex to this existing TypeScript Node.js CLI.

Repository:
Benny3840/Jarvis

Base commit:
ad3114b498bf93aa6c688c1a0eeefa26c039fd23

Requirements:

1. Install the convex package using npm.
2. Initialise Convex inside the existing repository. Do not scaffold a separate application.
3. Create a typed Convex schema for:
   - tasks
   - reminders
   - memories
   - conversations
   - assistantState
4. Create query and mutation functions for each table.
5. Introduce a persistence interface so the current CLI services do not depend directly on Convex.
6. Keep the existing JSON PersistentState implementation as a local fallback.
7. Add a Convex persistence implementation.
8. Select the persistence provider using an environment variable.
9. Do not add React, Next.js or browser-specific code.
10. Preserve all existing CLI behaviour and tests.
11. Add tests for the persistence abstraction.
12. Run type-checking and the full test suite.
13. Commit the completed work as one logical commit.

Do not create or enter Convex credentials, deployment keys or secrets without stopping for user approval.
