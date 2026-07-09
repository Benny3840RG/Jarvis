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