# Jarvis deployment and token rotation

This runbook documents Jarvis's current development deployment, local environment, GitHub Actions secrets, backups, and service-token rotation.

## Hard deployment boundary

Jarvis currently has one authorised Convex deployment:

```text
Deployment: dev:outgoing-ram-798
URL: https://outgoing-ram-798.convex.cloud
```

This is a persistent development deployment, not an anonymous or disposable backend. Test records must be cleaned up after smoke tests.

**No Convex production deployment is authorised.** Do not run `npx convex deploy`, create a production deployment, or attach Jarvis to another Convex project without Benny's explicit approval.

## Local development environment

Convex creates and updates `typescript/.env.local`. Jarvis also loads this file at runtime. It must remain ignored by Git and should have private file permissions.

```text
CONVEX_DEPLOYMENT=dev:outgoing-ram-798
CONVEX_URL=https://outgoing-ram-798.convex.cloud
PERSISTENCE_PROVIDER=convex
JARVIS_SERVICE_TOKEN=<strong random development secret>
JARVIS_TIMEZONE=Australia/Melbourne
OPENAI_API_KEY=<server-side OpenAI API key>
```

Rules:

- `JARVIS_SERVICE_TOKEN` in `.env.local` must exactly match the value stored in the Convex development environment.
- `OPENAI_API_KEY` is server-only. Never expose it in browser code, logs, screenshots, issues, pull requests, or chat.
- `CONVEX_URL` is routing information, not an authentication secret.
- Never commit `.env.local` or any secret-bearing environment file.

Set the development service token interactively so it does not appear in shell history:

```bash
cd typescript
npx convex env set JARVIS_SERVICE_TOKEN
```

## GitHub Actions secrets

A development-only sync workflow may use these repository secrets:

```text
CONVEX_DEPLOY_KEY
JARVIS_SERVICE_TOKEN
OPENAI_API_KEY
```

`CONVEX_DEPLOY_KEY` must be a deploy key generated for the existing development deployment `dev:outgoing-ram-798`. Do not add a production deploy key to this repository.

GitHub hides secret values after they are saved. Only the secret names should be visible in repository settings.

## JSON provider

When `PERSISTENCE_PROVIDER` is unset or set to `json`, the maintained TypeScript runtime stores data at:

```text
typescript/data/jarvis-state.json
```

The file, its lock file, temporary writes, backups, and corrupt-file quarantine copies must not be committed.

## HTTP service configuration

The HTTP server starts with:

```bash
cd typescript
npm run start:http
```

Relevant variables:

| Variable | Purpose |
| --- | --- |
| `JARVIS_SERVICE_TOKEN` | Current Bearer token required by authenticated HTTP and Convex operations |
| `JARVIS_SERVICE_TOKEN_PREVIOUS` | Optional previous token during a controlled rotation window |
| `JARVIS_HTTP_HOST` | Listen host; defaults to `127.0.0.1` |
| `JARVIS_HTTP_PORT` | Listen port; defaults to `3000` |
| `JARVIS_TIMEZONE` | IANA timezone, normally `Australia/Melbourne` |
| `PERSISTENCE_PROVIDER` | `json` or `convex` |
| `CONVEX_URL` | Required for Convex persistence |
| `OPENAI_API_KEY` | Required for live Totality reasoning |

## Service-token rotation

Jarvis accepts one current token and one optional previous token. Rotation must update the Convex development environment and local callers without exposing either value.

From `typescript/`:

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

If the smoke test fails, keep `JARVIS_SERVICE_TOKEN_PREVIOUS` configured until `.env.local` and all callers are corrected. Removing the previous token is the revocation step.

For emergency revocation, replace the current token immediately and do not configure `JARVIS_SERVICE_TOKEN_PREVIOUS`.

## Backup before destructive work

Create and verify a timestamped backup before schema migration, restore work, destructive maintenance, or an intentionally authorised production change:

```bash
cd typescript
BACKUP_FILE="backups/jarvis-$(date +%Y%m%d-%H%M%S).json"
npm run backup -- export "$BACKUP_FILE"
npm run backup -- verify "$BACKUP_FILE"
```

Verification restores into isolated temporary JSON storage and does not mutate the configured live provider.

## Development function sync

First verify the checkout and deployment identity:

```bash
cd typescript
git checkout main
git pull --ff-only origin main

grep -qx 'CONVEX_DEPLOYMENT=dev:outgoing-ram-798' .env.local
grep -qx 'CONVEX_URL=https://outgoing-ram-798.convex.cloud' .env.local
```

If either `grep` fails, stop. Do not let Convex create or select another project.

Then run the normal gates, sync once, and execute the self-cleaning development smoke test:

```bash
npm ci
npm run check
npx convex dev --once
npm run smoke:convex
```

The smoke command independently refuses any deployment whose `CONVEX_DEPLOYMENT` does not start with `dev:`.

## Production

Production commands are intentionally omitted from this operational runbook. Production remains blocked until Benny gives an explicit deployment checkpoint and the deployment identity, backup, migration, rollback, and smoke strategy are reviewed first.
