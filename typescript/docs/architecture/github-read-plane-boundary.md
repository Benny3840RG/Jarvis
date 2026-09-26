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
  App private key, **down-scoped to the one configured repository with read-only
  permissions**, and validated on receipt (a token that comes back broader than
  requested is refused). Tokens are never persisted. The private key lives
  outside the repo in host-controlled **systemd credential storage** and is read
  **only** from `$CREDENTIALS_DIRECTORY` — there is no inline-key env var and no
  arbitrary key path. Key and token never appear in logs, receipts, errors,
  config output, or tool results.
- **Network.** Deny-by-default egress. Only verified **HTTPS/443 to
  `api.github.com`**, via a hard-coded API origin. No arbitrary URLs, git
  transport, raw-content/uploads/codeload hosts, webhook ingress, or cross-host
  redirects in this slice.
- **Request scope.** Every request path is **fixed to the one configured
  repository** by an endpoint builder keyed on the read tool; the caller passes
  typed resource ids (PR/issue number, commit SHA), never a raw path. The read
  plane cannot be pointed at another repository or a non-repo endpoint.

## Code that enforces it

| Module                                     | Boundary                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/development/githubReadEgress.ts`      | Hard-coded `GITHUB_API_ORIGIN`; `assertGitHubApiUrl` (origin/scheme/credential/port/redirect refusal, fail-closed); `guardedGitHubFetch` (forces `redirect: "error"`, re-checks the response origin).                                                   |
| `src/development/githubReadAuth.ts`        | `resolveGithubAppReadConfigFromEnv` (fail-closed; systemd-credential-only key, fixed `owner/repo`); RS256 App-JWT signing; `mintInstallationToken` (repo+read-only down-scoped token over the egress guard, returned-scope validated, redacted errors). |
| `src/development/githubReadEndpoints.ts`   | `parseGithubRepository` (validated `owner/repo`); `buildGithubReadPath` (repository-fixed path per read tool from typed ids); `assertWithinRepository` backstop.                                                                                        |
| `src/development/githubReadPlaneClient.ts` | Binds all: allowlist + `assertGitHubReadOnly` tool check, repository-fixed path builder, egress-guarded target, in-memory-only down-scoped short-lived token. Reads only — no write/merge/approve method exists.                                        |
| `src/development/githubReadPlane.ts`       | The frozen read-only tool surface (prior slice).                                                                                                                                                                                                        |

Tests: `tests/githubReadEgress.test.ts`, `tests/githubReadAuth.test.ts`,
`tests/githubReadEndpoints.test.ts`, `tests/githubReadPlaneSurface.test.ts` —
prove the boundaries (no write/merge/approve op on the surface; requests cannot
escape the approved API origin; the minted token is down-scoped and validated;
every request path is fixed to the configured repository), all offline with an
injected fetch and a generated test key.

## Provisioning checklist (Benny, outside the repo — required for live use)

1. Create the dedicated GitHub App; install it **only** on `Benny3840/Jarvis`.
2. Grant read-only **Metadata, Contents, Pull Requests, Issues**; grant **no**
   write/merge/approve permission.
3. Place the App private key in host-controlled **systemd credential storage**
   (`LoadCredential=`), exposed to the process under `$CREDENTIALS_DIRECTORY`.
4. Set in the environment:
   - `JARVIS_GITHUB_READ_APP_ID`
   - `JARVIS_GITHUB_READ_INSTALLATION_ID`
   - `JARVIS_GITHUB_READ_REPOSITORY` (`owner/repo`, the one repository the plane
     may read)
   - `JARVIS_GITHUB_READ_PRIVATE_KEY_CREDENTIAL` — the **credential name** under
     `$CREDENTIALS_DIRECTORY` (i.e. the `LoadCredential=<name>:…` name). No inline
     key and no arbitrary path are accepted.
5. Set the environment's egress policy to permit only `api.github.com:443`.

Until 1–4 are present and valid (including a readable key under
`$CREDENTIALS_DIRECTORY`), `resolveGithubAppReadConfigFromEnv` returns `null` and
no read client is constructed (fail-closed). The code merges dormant and refuses
to operate unless valid credentials are injected and the origin guard passes.

## Deliberately not in this slice

- **Typed per-endpoint helpers.** `GithubReadPlaneClient.read({ tool, params })`
  and the repository-fixed builders (`buildGithubReadPath`) are the boundary core;
  richer typed wrappers (get PR, list issues, …) and branch/tag ref support layer
  on later. Only commit **SHA** refs are accepted for now (unambiguous, no slash).
- **Live verification.** No live GitHub call is made or asserted here — it awaits
  Benny's App provisioning and the egress allowlist. The boundary logic is proven
  offline.
- **Token-mint POST note.** Minting an installation token is an HTTP `POST` to
  `api.github.com/app/installations/{id}/access_tokens`. It is App-auth plumbing,
  not a repository write, and stays on the approved origin. The _exposed tool
  surface_ remains reads only.
