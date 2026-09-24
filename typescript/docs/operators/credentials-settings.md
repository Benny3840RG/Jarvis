# Credentials settings

Settings → Credentials is a status and guided-rotation surface for machine secrets. It is not a
sign-in. The service token is not a password.

Three secrets stay separate:

| Secret                          | Role                                                                         | Overlap variable                         |
| ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| `JARVIS_SERVICE_TOKEN`          | Authenticates a trusted Jarvis client to owner `jarvis-cli`                  | `JARVIS_SERVICE_TOKEN_PREVIOUS`          |
| `JARVIS_APPROVAL_TOKEN`         | Second factor for tool-action approve and revoke                             | `JARVIS_APPROVAL_TOKEN_PREVIOUS`         |
| `JARVIS_DELIVERY_RUNTIME_TOKEN` | Authorises quote delivery-ledger writes. Must differ from the service token. | `JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS` |

The HTTP read model at `GET /api/v1/settings/credentials` returns fingerprints (a short SHA-256
prefix), overlap flags, and bind posture. It does not return token values. Fingerprints are
derived when the process starts. A missing service token fails closed: dependent
`GET /api/v1/status` returns 503, and the loopback page shows a fail-closed banner. A missing
approval token warns “Approvals unavailable.” on Credentials and on tool-action approval. It does
not block the rest of Settings.

## Where generation is allowed

The MCP operator console shows status and runbook links. It does not generate tokens, and it does
not call `npx convex env set`.

Generation is only on the loopback page `GET /settings/credentials` (default
`http://127.0.0.1:3000/settings/credentials`). The new token is created in the browser, shown
once, and then discarded. The page content-security policy blocks network calls, so the value
cannot enter an API body, an MCP tool argument, a URL, or the model. Non-loopback binds do not
serve that page. There is no control that turns on remote HTTP by itself. Remote HTTP stays
fail-closed until TLS, OIDC, allowed origins, and limits are configured together.

## CLI / runbook parity

The page guides the same commands as the [README rotation](../../../README.md#service-token-rotation).
Convex changes stay operator-driven.

| UI                          | Operator action                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Generate service token      | `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`                                                     |
| Set Convex current/previous | `printf '%s\n' "$OLD_TOKEN" \| npx convex env set JARVIS_SERVICE_TOKEN_PREVIOUS` and the same for `JARVIS_SERVICE_TOKEN`, via stdin |
| Remove previous             | `npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS` (approval and delivery use their own `*_PREVIOUS` names)                      |
| Local env                   | Edit `.env.local`, then `chmod 600 .env.local`                                                                                      |
| Verify                      | `npm run smoke:convex` (deployments starting with `dev:` only)                                                                      |
| HTTP status                 | `curl --config - http://127.0.0.1:3000/api/v1/status` with the Bearer value supplied from the environment, not from the page        |
| Start HTTP / preview        | `npm run start:http` / `npm run start:preview`                                                                                      |

End overlap asks you to type `END OVERLAP`. While verification is failing, that action is hidden
and it is never the primary button. Confirming it only reveals the `env remove` command. It does
not change Convex or `.env.local` for you.

If smoke fails, keep the previous token set until the local token is corrected. Do not paste
tokens into Git, logs, issues, or chat. See [SECURITY.md](../../../SECURITY.md).
