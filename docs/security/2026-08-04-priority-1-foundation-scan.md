# Priority 1 Foundation Security Scan — 2026-08-04

## Scope and method

This report records the Priority 1 foundation security scan performed against `Benny3840RG/Jarvis` using the GitHub connector as the source of truth.

Local checkout and local scanner execution were blocked in the available sandbox by DNS failure when resolving `github.com`. Because of that, this is a connector-backed standard scan, not a claim of exhaustive local whole-repository static analysis. The scan focused on the highest-risk implementation surfaces for the current foundation work:

- HTTP and MCP authentication boundaries.
- HTTP and MCP remote-exposure controls.
- Service-token and approval-token handling.
- Outlook delegated OAuth and Microsoft Graph quote-delivery paths.
- Backup/import file handling.
- Command execution and dynamic JavaScript execution sinks.
- Public-route exposure.
- GitHub Actions workflow supply-chain controls.
- Control-plane CODEOWNERS and security policy coverage.
- Previously identified CodeQL and health-evidence safety issues.

## Findings ledger

| ID | Area | Disposition | Evidence | Resolution |
| --- | --- | --- | --- | --- |
| JARVIS-SEC-001 | MCP API origin / service-token egress | Reportable, remediated | `JARVIS_MCP_HOST` was loopback-only, but `JARVIS_API_BASE_URL` accepted any HTTP/HTTPS URL while `JarvisApiClient` attaches `JARVIS_SERVICE_TOKEN` to all API requests. A bad environment value could send the service token to a non-Jarvis origin before the approved remote OAuth/TLS gateway exists. | PR #280 rejects non-loopback API origins and embedded credentials until the remote gateway boundary exists. CI passed: TypeScript checks `30823289076`, Copilot Review Check `30823290781`. |
| JARVIS-SEC-002 | Widget script extraction / CodeQL bad HTML filtering regexp | Reportable, remediated | PR #276 proposed a broader HTML-parsing regex, but main still contained the strict `<script>` extraction regex in `typescript/tests/mcpWidget.test.ts`. | PR #279 replaced regex script extraction with deterministic static string boundaries. CI passed: TypeScript checks `30822575688`, Copilot Review Check `30822580976`. |
| JARVIS-SEC-003 | Health-evidence post-validation mutation | Reportable, remediated | `HealthMonitor` stored and returned mutable metric arrays, allowing callers to alter validated health evidence after construction. | PR #278 snapshots and freezes metrics and returns readonly frozen evidence. CI passed: TypeScript checks `30822207574`, Copilot Review Check `30822205799`. |
| JARVIS-SEC-004 | Shared service-token authentication model | Deferred design risk | HTTP and MCP endpoints remain protected by a shared Bearer service token. Current listener config rejects non-loopback binding, so this is not presently a remote exposure bug. It remains unsuitable for production or non-loopback access. | Keep as Priority 3 work: replace with proper OIDC/OAuth before remote exposure. Tracked by issue #306. |
| JARVIS-SEC-005 | Backup file read symlink handling | Not reportable in current threat model; hardening candidate | Backup restore/verify paths are local operator-controlled CLI inputs. Write path refuses overwrite and uses safe temporary writes. Read path uses `stat`/`readFile`, so a local operator can intentionally read a symlink target. | No immediate remediation required for remote threat model. Consider `lstat` + `open(O_NOFOLLOW)` for defence-in-depth. |
| JARVIS-SEC-006 | Outlook delegated OAuth refresh-token handling | Rejected / controlled | Refresh token file path must be absolute. Read path uses `O_NOFOLLOW`, validates regular file, owner-readable-only style permissions and token shape. Rotation writes 0600 temporary file, fsyncs, renames and fsyncs the directory. | No finding. Live proof remains tracked by issue #293. |
| JARVIS-SEC-007 | Microsoft Graph quote delivery | Rejected / controlled | Quote email prepare requires finalised quote revision, matching quote ID, fingerprint, recipient/subject/body bounds, PDF media type, `.pdf` filename without path separators, maximum 2 MiB attachment and SHA-256 digest match. Graph calls use immutable IDs and fixed Graph origin. | No finding. Live proof remains tracked by issues #294 and #297. |
| JARVIS-SEC-008 | Dynamic command execution | Rejected / fixed-command local tooling only | Connector search found fixed-command local/tooling uses: `typescript/src/tools/runPaddock.ts` invokes a fixed `paddock` command, and `typescript/jarvis-console-01/scripts/check-audit.mjs` invokes a fixed `git` command. No attacker-controlled command data or production request-to-command path was demonstrated in this connector-backed review. | No reportable injection finding from the reviewed paths; keep the scan wording scoped to reachable production request handling and revisit if command inputs become user-controlled. |
| JARVIS-SEC-009 | Dynamic JavaScript execution | Rejected / test-only | Connector search found `new Function`/VM usage in tests and static skill/reference documentation, not production request handling. `eval(` search returned no hits. | No finding from connector-backed scan. |
| JARVIS-SEC-010 | Public HTTP routes | Rejected / intended exposure | Only `healthz` is marked `@PublicRoute()`. Operator API routes remain guarded by `ServiceTokenGuard`. | No finding. |
| JARVIS-SEC-011 | GitHub Actions supply-chain and control-plane ownership | Reportable, remediated | The original scan found mutable action tags, credential-persisting checkout defaults, and missing control-plane ownership/security policy. | PR #283 remediated the main workflow set. PR #298 remediated the scheduled health-check exception. Current `main` inspection at `981ee36bfcbeaa406194c18fcab240dac9d3d192` shows workflow actions pinned to full commit SHAs, checkout credentials disabled, `.github/CODEOWNERS` present, and root `SECURITY.md` present. |

## Controls confirmed

- HTTP listener defaults to `127.0.0.1` and rejects non-loopback hosts until the approved OAuth 2.1, TLS and deployment boundary exists.
- MCP listener defaults to `127.0.0.1` and rejects non-loopback hosts under the same rule.
- Service-token validation uses SHA-256 digests before `timingSafeEqual`, avoiding token-length timing exceptions and avoiding secret logging.
- Tool-action approval and revocation require a second approval token, separate from the shared service token.
- Outlook token refresh is disabled unless explicitly configured, uses fixed Microsoft consumer token endpoint and fixed approved scopes.
- Quote-delivery Graph calls validate attachment digest and request immutable message IDs.
- Backup restore refuses non-empty target providers and verifies restored state.
- GitHub Actions workflow dependencies are pinned to full commit SHAs after the workflow-hardening repairs.
- Checkout credentials are disabled except where a job explicitly performs an authenticated push.
- Control-plane files have CODEOWNERS coverage and a root security policy.

## Residual risks and blockers

1. **Full local whole-repository scan remains blocked in this environment.** The sandbox could not resolve `github.com`, so local clone, local scanner execution and full file inventory verification could not be completed here.
2. **Shared service-token model is acceptable only while HTTP/MCP remain loopback-only.** Remote exposure must not proceed until Priority 3 replaces it with proper OIDC/OAuth and gateway controls.
3. **Backup symlink read hardening is optional but sensible.** It is not attacker-reachable in the current CLI threat model, but `readBackupFile` could be tightened later with `lstat` and `O_NOFOLLOW` for consistency with Outlook token storage.
4. **Live observability and Outlook commissioning are not security-scan evidence.** Sentry/PostHog credentials, Microsoft OAuth material, live mailbox activity, and production deployment remain deliberately absent and are tracked by issues #302, #293, #294, #297, and #307.

## Verification record

- PR #278 merged: immutable health evidence. TypeScript checks `30822207574`; Copilot Review Check `30822205799`.
- PR #279 merged: CodeQL script extraction repair. TypeScript checks `30822575688`; Copilot Review Check `30822580976`.
- PR #280 merged: MCP API origin lock-down. TypeScript checks `30823289076`; Copilot Review Check `30823290781`.
- PR #283 merged: workflow hardening; exact-head verification was completed before landing.
- PR #298 merged: scheduled health-check workflow hardening; exact-head verification passed on `67f24386`.

## Slice 3 status

Priority 1 / Slice 3 is complete for the connector-backed scan path. It produced one new remediated finding during this pass (`JARVIS-SEC-001`), confirmed two already-known remediated foundation findings (`JARVIS-SEC-002`, `JARVIS-SEC-003`), and records the exact local-scan blocker instead of pretending complete local coverage exists.

## Slice 4 status

Priority 1 / Slice 4 is complete for the repository workflow/configuration scope on current `main`: all discovered GitHub Actions are pinned to immutable commit SHAs, checkout credential persistence is disabled unless explicitly required, control-plane CODEOWNERS coverage is present, and `SECURITY.md` exists. The live local whole-repository checkout scan remains a separate environment limitation, not an open repository repair.
