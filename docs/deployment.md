# Jarvis deployment and token rotation

This document covers the distinction between the development and production deployment modes, the required environment variables, and safe service-token rotation.

## Development versus production

Jarvis is a single-operator system. There is no multi-tenant production service. "Production" means the deployment you trust with live data and use day-to-day; "development" is a throwaway deployment used for schema changes, smoke tests, and feature work.

| | Development | Production |
|---|---|---|
| **Convex project** | Separate Convex project or the `dev` deployment of the same project | `prod` deployment or a separate dedicated project |
| **`CONVEX_URL`** | `https://<project>.convex.cloud` pointing at the dev deployment | `https://<project>.convex.cloud` pointing at the prod deployment |
| **`JARVIS_SERVICE_TOKEN`** | A distinct secret used only for development | A distinct secret used only for production — never shared with dev |
| **Data** | Ephemeral — safe to wipe and reseed | Authoritative — must be backed up before any schema or restore operation |
| **Smoke test** | Safe to run `npm run smoke:convex` | Never run the smoke test against the production deployment |

### Environment file layout (recommended)

Keep separate files and never commit either to source control:

```
.env.dev     # CONVEX_URL and JARVIS_SERVICE_TOKEN for development
.env.prod    # CONVEX_URL and JARVIS_SERVICE_TOKEN for production
```

Load the correct file before starting Jarvis:

```bash
# Development
set -a && source .env.dev && set +a
npm start            # or node --import tsx src/index.ts

# Production
set -a && source .env.prod && set +a
npm start
```

### JSON provider (no Convex)

If `PERSISTENCE_PROVIDER` is unset or `json`, Jarvis writes to `~/.jarvis/jarvis.json`. No Convex variables are required. The concepts of development and production still apply: use separate home directories or separate file paths when testing destructive operations.

---

## HTTP service configuration

The HTTP server (`npm run start:http`) reads from the same environment variables and additionally requires:

| Variable | Description |
|---|---|
| `JARVIS_SERVICE_TOKEN` | ****** required for every authenticated endpoint |
| `JARVIS_PREVIOUS_TOKEN` | Optional previous token retained during rotation (see below) |
| `CONVEX_URL` | Required when `PERSISTENCE_PROVIDER=convex` |
| `PERSISTENCE_PROVIDER` | `json` (default) or `convex` |

---

## Service-token rotation

The HTTP server accepts one current token and one optional previous token simultaneously. This allows a zero-downtime rotation: issue a new token, start accepting it as current while the old token is accepted as previous, then remove the old token once all callers are updated.

### Rotation procedure

1. **Generate a new token.** Use a cryptographically random value with at least 32 bytes of entropy:
   ```bash
   openssl rand -hex 32
   ```

2. **Stage the rotation.** Set the new token as current and the old token as previous:
   ```bash
   JARVIS_PREVIOUS_TOKEN="$JARVIS_SERVICE_TOKEN"
   JARVIS_SERVICE_TOKEN="<new-token>"
   ```

3. **Restart the HTTP server** so the new variables take effect. Both the old and the new token are now accepted.

4. **Update all callers** (scripts, automation, ChatGPT plugin configuration, etc.) to use the new token.

5. **Remove the previous token** once all callers are updated:
   ```bash
   unset JARVIS_PREVIOUS_TOKEN
   ```

6. **Restart the HTTP server** again. Only the new token is now accepted.

### Revocation (emergency)

If a token is compromised, skip the staged rotation:

1. Generate a new token immediately.
2. Set `JARVIS_SERVICE_TOKEN` to the new token and **do not set** `JARVIS_PREVIOUS_TOKEN`.
3. Restart the HTTP server. The old token is immediately rejected.
4. Update all callers.

### Rules

- Never put token values in logs, error responses, issue comments, or test fixtures.
- Never reuse a revoked token.
- Tokens for the development deployment must be different from tokens for the production deployment.
- Do not commit `.env.*` files or any file containing `JARVIS_SERVICE_TOKEN` to source control.

---

## Backup before any destructive operation

Export a verified backup before every schema migration, restore operation, or major Convex function redeployment:

```bash
cd typescript
npm run backup
```

Verify the exported file by inspecting it or restoring it into an isolated empty provider. See `docs/failure-behaviour.md` for the restore contract.

---

## Convex function sync

### Development

```bash
cd typescript
npx convex dev --once --tail-logs disable
```

Run `npm run smoke:convex` after every sync to verify the development deployment is healthy.

### Production

```bash
cd typescript
npx convex deploy --cmd "echo skip" 2>/dev/null || npx convex deploy
```

Review the Convex dashboard after deploying to confirm all functions are active. Never run `npm run smoke:convex` against the production deployment — it creates and deletes real records.
