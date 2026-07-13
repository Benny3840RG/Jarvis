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
task remove <id>
reminder add <title> --due <when>
reminder list
reminder remove <id>
```

Fuzzy phrases containing `task` or `remind` do not write data. Jarvis prints the supported command syntax instead.

### Local JSON persistence

JSON is the default provider. Runtime data is stored in `typescript/data/jarvis-state.json`, which is ignored by Git. Writes use a temporary file plus atomic rename. Malformed or unsupported files are moved aside with a `.corrupt-*` suffix so the CLI can start with an empty document while preserving the bad file for recovery.

Removing the tracked runtime file does not remove its older copies from Git history. Scrub repository history separately if an earlier state file contained sensitive personal data.

The JSON provider serialises operations inside one process. It does not provide cross-process file locking, so do not run two JSON-backed Jarvis CLI processes against the same file.

### Convex persistence and service authentication

Convex is opt-in. This single-user CLI uses a shared service token rather than pretending to be a browser user with an OIDC identity provider. Every public Convex query and mutation checks the token against the deployment environment before accessing the owner-scoped records.

Convex creates `typescript/.env.local` when the project is linked. Add these local-only values to that file:

```text
PERSISTENCE_PROVIDER=convex
JARVIS_SERVICE_TOKEN=<strong random secret>
```

The Convex development deployment must contain the same secret:

```bash
npx convex env set JARVIS_SERVICE_TOKEN
```

Enter the value interactively so it does not appear in shell history. The CLI loads `.env.local` on startup. `CONVEX_URL` is public routing information and is not treated as authentication.

This service-token model is intentionally single-user. Replace it with a real OIDC user-authentication provider before exposing Jarvis as a multi-user application.

After the deployment secret is configured, run `npx convex dev` to type-check, generate `convex/_generated`, and sync the functions to the development deployment. Do not use `npx convex deploy` until the production deployment is intentionally being configured.

### Service-token rotation

The deployment accepts an optional `JARVIS_SERVICE_TOKEN_PREVIOUS` during a controlled overlap window. This allows the server and local CLI to switch tokens without downtime. The previous token is rejected again as soon as the overlap variable is removed.

First sync the overlap-capable auth code while the existing token is still current:

```bash
cd typescript
npx convex dev --once --tail-logs disable
```

Then rotate without printing either token:

```bash
set -a
. ./.env.local
set +a

OLD_TOKEN="$JARVIS_SERVICE_TOKEN"
NEW_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"

printf '%s\n' "$OLD_TOKEN" | npx convex env set JARVIS_SERVICE_TOKEN_PREVIOUS
printf '%s\n' "$NEW_TOKEN" | npx convex env set JARVIS_SERVICE_TOKEN

sed -i '/^JARVIS_SERVICE_TOKEN=/d' .env.local
printf 'JARVIS_SERVICE_TOKEN=%s\n' "$NEW_TOKEN" >> .env.local
chmod 600 .env.local

unset JARVIS_SERVICE_TOKEN
npm run smoke:convex
npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS

unset OLD_TOKEN NEW_TOKEN
```

If the smoke test fails, keep `JARVIS_SERVICE_TOKEN_PREVIOUS` set until the local token is corrected. Removing it is the revocation step for the old credential. Never paste either token into Git, logs, issues, or chat.

### Live Convex smoke test

The smoke command refuses any deployment whose `CONVEX_DEPLOYMENT` does not start with `dev:`. It creates a uniquely named task and reminder, verifies them through fresh provider instances, completes and removes the task, removes the reminder, and verifies cleanup. A `finally` block retries cleanup after failures, and surfaced errors redact the configured service token.

Run it only after syncing the current functions to the development deployment:

```bash
cd typescript
npx convex dev --once --tail-logs disable
npm run smoke:convex
```

Do not run the smoke command while deliberately testing against production. The deployment guard is there to fail closed.

### Backup, verification, and restore

Backups are provider-neutral JSON archives containing assistant state, tasks, reminders, source IDs, and source timestamps. Files are created with private permissions and an existing backup file is never overwritten.

```bash
cd typescript
npm run backup -- export backups/jarvis-2026-07-13.json
npm run backup -- verify backups/jarvis-2026-07-13.json
```

`verify` restores the archive into isolated temporary JSON storage, checks tasks, reminders, completion state, and remapped assistant-state references, then deletes the temporary files. It does not touch the configured live provider.

A real restore is deliberately empty-target only and requires an explicit confirmation flag:

```bash
npm run backup -- restore backups/jarvis-2026-07-13.json --confirm-empty-target
```

Restore refuses any provider that already contains state, tasks, or reminders. It rolls back records created during a failed restore. Because JSON and Convex issue their own record IDs and timestamps, a portable restore recreates those values; known and nested record-ID references inside assistant state are remapped automatically. The archive retains the original IDs and timestamps for audit purposes.

## Checks

```bash
cd typescript
npm ci
npm run type-check
npm test
```

Keep it boring first. Boring is what works.
