# GitHub read-plane auth & network boundary (PR F, auth/network slice)

## What this is

The acquisition plan brings GitHub in as an **acquired read capability** that
sits _underneath_ Jarvis authority. This slice adds the runtime code that keeps
that capability inside two hard boundaries — authentication and network egress —
and binds them to the already-frozen tool-surface contract
(`githubReadPlane.ts`).

It is deliberately separate from the **governed merge path**
(`FetchGitHubDevelopmentClient` / `createGitHubMergeToolDefinition`, authed with
`JARVIS_GITHUB_TOKEN`). That path carries owner-only merge authority under the
Omega governed boundary (AUTH-INV-01). The read plane must never reuse it and
never gain write power. Acquired reads do not become an authority side-door.

## The decision (owner-set, 2026-09-26)

- **Identity.** A dedicated GitHub App installed **only** on `Benny3840/Jarvis`.
  Read-only **Metadata, Contents, Pull Requests, Issues**. Further read scopes
  only when a concrete, approved read operation proves it needs them. **No write
  permission may exist on the App.**
- **Auth.** Short-lived installation access tokens minted at runtime from the
  App private key. Tokens are never persisted. The private key lives outside the
  repo in host-controlled **systemd credential storage**. Key and token never
  appear in logs, receipts, errors, config output, or tool results.
- **Network.** Deny-by-default egress. Only verified **HTTPS/443 to
  `api.github.com`**, via a hard-coded API origin. No arbitrary URLs, git
  transport, raw-content/uploads/codeload hosts, webhook ingress, or cross-host
  redirects in this slice.

## Code that enforces it

| Module                                     | Boundary                                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/development/githubReadEgress.ts`      | Hard-coded `GITHUB_API_ORIGIN`; `assertGitHubApiUrl` (origin/scheme/credential/port/redirect refusal, fail-closed); `guardedGitHubFetch` (forces `redirect: "error"`, re-checks the response origin). |
| `src/development/githubReadAuth.ts`        | `resolveGithubAppReadConfigFromEnv` (fail-closed credential resolution); RS256 App-JWT signing; `mintInstallationToken` (short-lived token over the egress guard, redacted errors).                   |
| `src/development/githubReadPlaneClient.ts` | Binds all three: allowlist + `assertGitHubReadOnly` tool check, egress-guarded target, in-memory-only short-lived token. Reads only — no write/merge/approve method exists.                           |
| `src/development/githubReadPlane.ts`       | The frozen read-only tool surface (prior slice).                                                                                                                                                      |

Tests: `tests/githubReadEgress.test.ts`, `tests/githubReadAuth.test.ts`,
`tests/githubReadPlaneSurface.test.ts` — prove both boundaries (no
write/merge/approve op on the surface; requests cannot escape the approved API
origin), all offline with an injected fetch and a generated test key.

## Provisioning checklist (Benny, outside the repo — required for live use)

1. Create the dedicated GitHub App; install it **only** on `Benny3840/Jarvis`.
2. Grant read-only **Metadata, Contents, Pull Requests, Issues**; grant **no**
   write/merge/approve permission.
3. Place the App private key in host-controlled **systemd credential storage**
   (`LoadCredential=`), exposed to the process under `$CREDENTIALS_DIRECTORY`.
4. Set in the environment:
   - `JARVIS_GITHUB_READ_APP_ID`
   - `JARVIS_GITHUB_READ_INSTALLATION_ID`
   - `JARVIS_GITHUB_READ_PRIVATE_KEY_FILE` (path under `$CREDENTIALS_DIRECTORY`)
     — or `JARVIS_GITHUB_READ_PRIVATE_KEY` (inline PEM) for non-systemd hosts.
5. Set the environment's egress policy to permit only `api.github.com:443`.

Until 1–4 are present, `resolveGithubAppReadConfigFromEnv` returns `null` and no
read client is constructed (fail-closed). The code merges dormant and refuses to
operate unless valid credentials are injected and the origin guard passes.

## Deliberately not in this slice

- **Typed per-endpoint helpers.** `GithubReadPlaneClient.read(tool, path)` is the
  boundary core; typed wrappers (get PR, list issues, …) layer on later.
- **Live verification.** No live GitHub call is made or asserted here — it awaits
  Benny's App provisioning and the egress allowlist. The boundary logic is proven
  offline.
- **Token-mint POST note.** Minting an installation token is an HTTP `POST` to
  `api.github.com/app/installations/{id}/access_tokens`. It is App-auth plumbing,
  not a repository write, and stays on the approved origin. The _exposed tool
  surface_ remains reads only.
