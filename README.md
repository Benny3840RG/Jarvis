# Jarvis

Jarvis is a local command-line assistant with durable JSON or Convex persistence.

The maintained application is the TypeScript CLI in `typescript/`. The root Python package is the original local-notes prototype; it is retained only for reference and does not share data, commands, tests, or persistence with the maintained application. See [Scaffold and runtime boundaries](typescript/docs/architecture/scaffold-and-runtime-boundaries.md).

## Legacy Python prototype

This entry point is not part of the maintained TypeScript/Convex runtime. Use it only to read or migrate notes previously stored in `~/.jarvis/notes.jsonl`.

### Python quick start

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

### Python commands

| Command              | What it does                                       |
| -------------------- | -------------------------------------------------- |
| `jarvis status`      | Checks the app can run and shows storage path.     |
| `jarvis checklist`   | Prints a practical daily trade/business checklist. |
| `jarvis note "text"` | Saves a timestamped local note.                    |
| `jarvis notes`       | Lists saved notes.                                 |

Local Python notes are stored in `~/.jarvis/notes.jsonl`.

## Maintained TypeScript CLI

Node.js 24 is the supported runtime. `typescript/.nvmrc` is the source of truth for local
development and CI, while `package.json` rejects unsupported major versions.

```bash
cd typescript
nvm use
npm ci
npm start
```

Durable commands are deliberately explicit:

```text
task add <title>
task list
task update <id> --title <title> [--category <category>]
task complete <id>
task remove <id>
reminder add <title> --due <when>
reminder list
reminder update <id> [--title <title>] [--due <when> | --clear-due]
reminder remove <id>
```

Update flags may be supplied in either order. At least one supported flag is required, duplicate or unknown flags are rejected, and `--due` cannot be combined with `--clear-due`. Fuzzy phrases containing `task` or `remind` do not write data. Jarvis prints the supported command syntax instead.

### Reminder due values

Jarvis always preserves the exact `--due` text as `dueRaw`. It also stores `dueAt` and `dueTimezone` when the value can be interpreted conservatively. Supported normalized forms include ISO timestamps with an offset, `YYYY-MM-DD`, Australian `DD/MM/YYYY`, `today 9am`, `tomorrow 9am`, and named weekdays such as `Friday 9am`.

Ambiguous or unrecognised text such as `after Claire calls` is retained without inventing a timestamp. Local wall-clock values use `JARVIS_TIMEZONE` when configured, otherwise the machine's IANA timezone. For Benny's normal deployment this can be made explicit in `.env.local`:

```text
JARVIS_TIMEZONE=Australia/Melbourne
```

Invalid timezone configuration fails the reminder command rather than saving a guessed time. Existing version 1 JSON documents and backup archives remain readable; their old free-form `due` value is migrated in memory to `dueRaw`.

### Local JSON persistence

JSON is the default provider. Runtime data is stored in `typescript/data/jarvis-state.json`, which is ignored by Git. Writes use a temporary file plus atomic rename. Malformed or unsupported files are moved aside with a `.corrupt-*` suffix so the CLI can start with an empty document while preserving the bad file for recovery.

Removing the tracked runtime file does not remove its older copies from Git history. Scrub repository history separately if an earlier state file contained sensitive personal data.

The JSON provider serialises mutations across local processes with an adjacent `.lock` file. Each mutation acquires the lock, re-reads the latest complete document, writes by atomic replacement, and releases the lock. Reads re-read the file so an already-running process sees changes made by another process. A live lock times out with an actionable error, while a lock left by a process that has exited is reclaimed. Convex remains the preferred provider for access from multiple machines.

### Convex persistence and service authentication

Convex is opt-in. This single-user CLI uses a shared service token rather than pretending to be a browser user with an OIDC identity provider. Every public Convex query and mutation checks the token against the deployment environment before accessing the owner-scoped records.

Convex creates `typescript/.env.local` when the project is linked. Add these local-only values to that file:

```text
PERSISTENCE_PROVIDER=convex
JARVIS_SERVICE_TOKEN=<strong random secret>
JARVIS_TIMEZONE=Australia/Melbourne
```

The Convex development deployment must contain the same service secret:

```bash
npx convex env set JARVIS_SERVICE_TOKEN
```

Enter the value interactively so it does not appear in shell history. The CLI loads `.env.local` on startup. `CONVEX_URL` is public routing information and is not treated as authentication.

This service-token model is intentionally single-user. Replace it with a real OIDC user-authentication provider before exposing Jarvis as a multi-user application. The accepted ownership and concurrency decision is documented in [`typescript/docs/architecture/ownership-and-concurrency.md`](typescript/docs/architecture/ownership-and-concurrency.md).

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

The smoke command refuses any deployment whose `CONVEX_DEPLOYMENT` does not start with `dev:`. It creates, updates, lists, re-reads through fresh provider instances, completes, removes, and cleans up a uniquely named task and reminder. It verifies task title/category changes and reminder title/due changes before cleanup. Cleanup is attempted after both successful and failed runs, and surfaced errors redact the configured service token.

Run it only after syncing the current functions to the development deployment:

```bash
cd typescript
npx convex dev --once --tail-logs disable
npm run smoke:convex
```

Do not run the smoke command while deliberately testing against production. The deployment guard is there to fail closed.

### Backup, verification, and restore

Backups are provider-neutral JSON archives containing assistant state, tasks, reminders, source IDs, source timestamps, and normalized reminder due data. Files are created with private permissions and an existing backup file is never overwritten. Version 1 archives remain accepted and are migrated to the current version during validation.

```bash
cd typescript
BACKUP_FILE="backups/jarvis-$(date +%Y%m%d-%H%M%S).json"
npm run backup -- export "$BACKUP_FILE"
npm run backup -- verify "$BACKUP_FILE"
```

`verify` restores the archive into isolated temporary JSON storage, checks tasks, reminders, completion state, due fields, and remapped assistant-state references, then deletes the temporary files. It does not touch the configured live provider.

A real restore is deliberately empty-target only and requires an explicit confirmation flag:

```bash
npm run backup -- restore "$BACKUP_FILE" --confirm-empty-target
```

Restore refuses any provider that already contains state, tasks, or reminders. It rolls back records created during a failed restore. Because JSON and Convex issue their own record IDs and timestamps, a portable restore recreates those values; known and nested record-ID references inside assistant state are remapped automatically. The archive retains the original IDs and timestamps for audit purposes.

## Checks

```bash
cd typescript
npm ci
npm run check
```

`npm run check` runs the TypeScript compiler, ESLint (including the Convex rules), Prettier verification, and the full test suite.

`npm run test:coverage` runs the same tests with Node's built-in coverage report. CI prints this report for every TypeScript pull request and `main` update; coverage output is diagnostic and does not alter runtime behaviour.

Keep it boring first. Boring is what works.
