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
prefix and suffix), overlap flags, and bind posture. It does not return token values or full
digests. Fingerprints are derived when the process starts. A missing service token fails closed:
dependent `GET /api/v1/status` returns 503, and the loopback page shows a fail-closed banner. A
missing approval token warns “Approvals unavailable.” on Credentials and on tool-action approval.
It does not block the rest of Settings.

`GET /settings/credentials` is a public loopback route. It does not require a Bearer token, so the
fail-closed banner can render when the service token is missing. The HTML embeds the full SHA-256
digests of the current and previous service tokens. That is deliberate: the page content-security
policy blocks network calls, and the browser still needs those digests to reject a delivery token
that matches the service token. The digests are not the tokens. They are not in the JSON read
model, the MCP widget, or a non-loopback response. Non-loopback binds do not serve the page.

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

End overlap asks you to type `END OVERLAP`. That reveals the `env remove` command. It does not run
the command, and it does not change Convex or `.env.local`. Caller-supplied verification state is
ignored: this page does not observe `npm run smoke:convex`, so idle, passing, and failing do not
unlock or hide removal. The action is never the primary button. Removing the previous token is an
operator command. Danger zone is not this page.

If smoke fails, keep the previous token set until the local token is corrected. Do not paste
tokens into Git, logs, issues, or chat. See [SECURITY.md](../../../SECURITY.md).
