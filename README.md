# Jarvis

A small local command-line assistant scaffold for Benny's workflow.

This repo is intentionally simple: no background magic. It gives you a working Python entry point and a TypeScript interactive CLI that can be expanded into reminders, job notes, quoting helpers, and daily trade checklists.

## Python quick start

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

## Python commands

| Command | What it does |
|---|---|
| `jarvis status` | Checks the app can run and shows storage path. |
| `jarvis checklist` | Prints a practical daily trade/business checklist. |
| `jarvis note "text"` | Saves a timestamped local note. |
| `jarvis notes` | Lists saved notes. |

Local Python notes are stored in `~/.jarvis/notes.jsonl`.

## TypeScript CLI

```bash
cd typescript
npm ci
npm start
```

Durable commands are deliberately explicit:

```text
task add <title>
task list
task complete <id>
reminder add <title> --due <when>
reminder list
reminder remove <id>
```

Fuzzy phrases containing `task` or `remind` do not write data. Jarvis prints the supported command syntax instead.

### Local JSON persistence

JSON is the default provider. Runtime data is stored in `typescript/data/jarvis-state.json`, which is ignored by Git. Writes use a temporary file plus atomic rename. Malformed or unsupported files are moved aside with a `.corrupt-*` suffix so the CLI can start with an empty document while preserving the bad file for recovery.

Removing the tracked runtime file does not remove its older copies from Git history. Scrub repository history separately if an earlier state file contained sensitive personal data.

The JSON provider serialises operations inside one process. It does not provide cross-process file locking, so do not run two JSON-backed Jarvis CLI processes against the same file.

### Convex persistence and authentication

Convex is opt-in and rejects anonymous clients. Configure an OIDC provider for the deployment, then provide an identity token to the CLI:

```bash
export PERSISTENCE_PROVIDER=convex
export CONVEX_URL='https://your-deployment.convex.cloud'
export CONVEX_AUTH_TOKEN='<OIDC identity token>'
```

The Convex deployment also needs:

```text
CONVEX_AUTH_ISSUER
CONVEX_AUTH_AUDIENCE
```

The deployment URL is public routing information, not authentication. Every Convex query and mutation derives ownership from `ctx.auth.getUserIdentity()` and only accesses documents belonging to that authenticated identity.

After choosing and configuring the real Convex deployment and auth provider, run `npx convex codegen` and the normal Convex deployment workflow. Generated files, deployment linking, credentials, and a real integration test are intentionally not fabricated in this repository change.

## Checks

```bash
cd typescript
npm ci
npm run type-check
npm test
```

Keep it boring first. Boring is what works.
