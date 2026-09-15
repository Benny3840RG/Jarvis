# Delegated Outlook runtime

Jarvis can compose the approved Microsoft Graph quote-mail provider and its reconciliation adapter for personal Outlook and tenant-pinned Microsoft 365 accounts. The integration is disabled by default and this repository contains no Microsoft credential.

## Authority boundary

Repository composition does not authorise or perform Microsoft consent, a live token exchange, a customer email, or a production deployment. Those remain operator-controlled actions.

The runtime is limited to:

- delegated `Mail.ReadWrite` for creating and observing the immutable draft;
- delegated `Mail.Send` for sending that prepared draft;
- `offline_access` for background refresh and reconciliation;
- approved, finalised quote PDFs through the existing `quotes:send` allowlist.

It does not add general outbound email.

## Required configuration

Set `JARVIS_OUTLOOK_ENABLED=true` to enable composition; absent or `false`
keeps it disabled. Choose either the legacy single-mailbox variables below or
`JARVIS_OUTLOOK_CONNECTIONS_JSON` from [Separate personal and business connections](#separate-personal-and-business-connections).
Do not combine these two configuration modes.

For legacy single-mailbox mode:

| Variable                            | Requirement                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `JARVIS_OUTLOOK_CLIENT_ID`          | Client ID of the approved delegated Microsoft app registration for the selected personal or business account       |
| `JARVIS_OUTLOOK_MAILBOX`            | Exact personal Outlook or Microsoft 365 business mailbox used by Graph                                             |
| `JARVIS_OUTLOOK_REFRESH_TOKEN_FILE` | Absolute path to that mailbox's owner-only refresh-token file                                                      |
| `JARVIS_OUTLOOK_TENANT_ID`          | Business tenant GUID for tenant-pinned Microsoft 365 authentication; omit only for the personal `/consumers/` flow |

Background reconciliation is independently disabled unless `JARVIS_RECONCILIATION_ENABLED=true` and its existing Convex/service-token configuration is complete. Enabling reconciliation without an Outlook adapter fails startup before the listener is ready.

**Pairing rule:** `JARVIS_OUTLOOK_ENABLED=true` requires `JARVIS_RECONCILIATION_ENABLED=true`. Maintained HTTP and preview entrypoints fail closed if Outlook is enabled while reconciliation is not, so quote sends cannot register without a worker that can resolve Graph `202 Accepted` outcomes.

## Secret-file requirements

The refresh token is a runtime secret, never repository configuration.

- Keep its parent directory private and not group- or world-writable.
- Store the token in a regular file, not a symbolic link.
- Set the file to owner-readable only (for example mode `0600`).
- Keep the path absolute.
- The token payload is bounded to 65,536 UTF-8 bytes; the serialized file may
  contain one additional newline byte. Both initial publication and rotation
  remain readable at that boundary, and larger payloads are rejected.
- Do not put the file in Git, application logs, backups, screenshots, or support bundles.

Jarvis reads the file without following symbolic links. Microsoft refresh-token rotation is written to an owner-only temporary file, flushed, atomically renamed, and directory-synced before the new access token is returned. Access tokens remain in process memory only.

## Runtime behaviour

The maintained HTTP and controlled-preview entrypoints create one composed Outlook runtime per process. Each configured mailbox has an independent access-token cache shared by its sending and reconciliation adapters.

A Graph `202 Accepted` response remains indeterminate. Jarvis does not report delivery from that response; the existing reconciliation worker observes the immutable message ID and records the terminal outcome.

Invalid booleans, incomplete enabled configuration, insecure token files, missing scopes, token rejection, and unavailable provider adapters fail closed with stable redacted error codes.

## Activation checklist

Before any live activation:

1. Register or select a Microsoft application that permits the intended personal or tenant-pinned business account.
2. Review and grant only `Mail.ReadWrite`, `Mail.Send`, and `offline_access`.
3. Provision the refresh token through a separately approved consent workflow.
4. Install it at the configured owner-only path.
5. Validate in a non-production environment without a customer recipient.
6. Obtain separate approval for a live customer email.
7. Obtain separate approval for production deployment.

Do not combine consent, a live send, and deployment into one change window.

## Separate personal and business connections

The named-connection mode supports up to two independent registrations. Set
`JARVIS_OUTLOOK_CONNECTIONS_JSON` to a JSON array with these non-secret fields:

- `id`: stable lowercase label, e.g. `personal` or `business`;
- `clientId`: separate app registration GUID for each connection;
- `mailbox`: exact mailbox address used by Graph;
- `tenantId`: business tenant GUID; omit only for the personal `/consumers/` flow;
- `refreshTokenFile`: a distinct absolute owner-only token path.

Do not mix this mode with the legacy `JARVIS_OUTLOOK_CLIENT_ID`,
`JARVIS_OUTLOOK_MAILBOX`, `JARVIS_OUTLOOK_REFRESH_TOKEN_FILE` or
`JARVIS_OUTLOOK_TENANT_ID` variables. The same global enabled flag and
reconciliation pairing gate still apply. Configuration alone does not activate it.
Legacy single-mailbox configuration remains supported; an optional
`JARVIS_OUTLOOK_TENANT_ID` pins that configuration to a business tenant.

### Operator setup

On the operator's Ubuntu computer, with Node 24 and PowerShell installed,
preinstall a validated **Microsoft.Graph.Authentication 2.36.1** distribution.
Use your administrator's trusted software provisioning process to validate the
publisher signature or compare the package against an independently approved
integrity digest before installing it. The
[Microsoft package version](https://www.powershellgallery.com/packages/Microsoft.Graph.Authentication/2.36.1)
is the version reference; merely finding a module with that name/version does not
prove its integrity. Keep its installed files protected from untrusted writers.

Setup requires that exact preinstalled version and imports it explicitly. It
never downloads, installs, or updates a PowerShell module, and stops before
state creation or administrator sign-in if the required version is absent.
Dependency validation is an operator prerequisite, not a claim made by this
script's version check. After that prerequisite is satisfied:

```bash
bash scripts/setup-outlook.sh
```

The script installs locked Node dependencies without install scripts, then:

1. Asks for the tenant GUID and both exact mailbox sign-in addresses.
2. Uses system-browser Microsoft Graph administrator sign-in (not device code).
3. Creates two dedicated native/public-client registrations with `http://localhost`
   redirect URIs: personal accounts only and business single-tenant respectively.
4. Resolves permission IDs from the tenant's Microsoft Graph service principal.
   Requests only delegated `offline_access Mail.ReadWrite Mail.Send` for Jarvis.
5. Grants those delegated permissions for the business user using
   `consentType=Principal`; never `AllPrincipals` or application permissions.
6. Saves and flushes non-secret effect intent **before** each application,
   service-principal or grant POST under
   `~/.config/jarvis/outlook/setup-state.json`. A private process lock serializes
   setup runs. Each new application has a persisted GUID marker in its display
   name; recovery searches only that exact marker and requires one result with
   the expected registration settings. Existing saved app IDs remain supported.
   Principal and grant recovery uses their exact client/user/resource scope.
   If a POST times out or its response/local save fails, rerunning performs
   read-only reconciliation of that effect. Missing or ambiguous results stop
   setup without another POST—even if the missing result might merely reflect
   delayed provider visibility. Do not delete the state/intent to force a retry;
   inspect the recorded operation in the tenant and resolve the uncertainty.
   Legacy state without pre-effect intents can verify already existing objects,
   but missing registrations, principals or grants require operator reconciliation
   and are never recreated automatically.
   Every collection read follows only same-resource Microsoft Graph pagination,
   with limits of 20 pages and 1,000 rows; loops, foreign links and ambiguity stop
   provisioning. Remote creation is not transactional.
7. Opens neither tenant-wide user consent nor Security Defaults. A policy refusal
   remains a refusal; inspect the sign-in logs, do not weaken policy to proceed.
8. Guides separate mailbox sign-ins through authorization-code + S256 PKCE with
   random state and a three-minute loopback-only callback listener. Open each
   printed URL on the same computer. The business user may differ from the admin.
   The registered `localhost` redirect keeps Microsoft's ephemeral-port matching.
   The callback binds `127.0.0.1` and `::1` on the same port, without a wildcard
   listener. An unavailable IPv6 socket is omitted only when localhost does not
   resolve to IPv6; other binding failures close all sockets before consent.
9. Exchanges and refreshes tokens in memory, then performs a read-only inbox-folder
   ID probe against the exact configured mailbox. No message contents, drafts or
   sends are needed. Only after this succeeds is the refresh token written to a new
   `0600` file in the private setup directory. Existing tokens are never overwritten
   by onboarding; reruns refresh/verify them. Reconnection uses a new private path.
   Initial publication reuses `FileRefreshTokenStore`: write and fsync a private
   temporary file, atomically link it to the absent final path, remove the temporary
   link, and fsync the directory. The link refuses an existing target, including a
   competing successful onboarding. Write/fsync failures before publication leave
   no final token; a process crash can leave a private temporary file. A failure
   after publication may leave a complete final token and requires verification,
   never overwriting or deleting it to force another consent attempt.

Administrator provisioning needs `Application.ReadWrite.All`,
`DelegatedPermissionGrant.ReadWrite.All` and `User.ReadBasic.All` on the Microsoft
Graph administrator tool, not on Jarvis. These administrative permissions do not
become mailbox runtime scopes. The script disconnects the process session after
provisioning. OAuth consent for each mailbox remains a human Microsoft sign-in.

Individual commands (run from `typescript/`):

The automated `setup-outlook.sh` / PowerShell flow targets Linux or WSL and uses
Unix `chmod` and `sync -f`. It explicitly rejects non-Linux platforms before
filesystem changes or Graph authentication, even if Unix tools are installed.
A custom `-SetupDirectory` must be an absolute
filesystem path; relative paths reject before directories or provider calls.
Browser onboarding requires POSIX ownership/mode checks (Linux, macOS or WSL).
Native Windows onboarding is unsupported until an ACL-based credential-store
boundary exists; it fails before consent instead of skipping ownership checks.

```bash
npm run outlook -- inspect --config "$HOME/.config/jarvis/outlook/connections.json"
npm run outlook -- connect --config "$HOME/.config/jarvis/outlook/connections.json" --connection personal
npm run outlook -- verify --config "$HOME/.config/jarvis/outlook/connections.json" --connection business
```

`inspect` performs no network or token I/O. `connect` and `verify` make live token
and read-only Graph calls. They do not enable HTTP/MCP, send mail, or deploy.
Keep the resulting token files outside backups and Git. A token rotation failure
or failed mailbox probe is not commissioning success. A folder probe establishes
current mailbox access, not successful email delivery or permanent authorization.

### Approved sender and durable routing

`inspect` prints the `senderConnection` value for each mailbox. Include that exact
value in the proposed `quotes:send` arguments, before human approval. It combines
the label with a SHA-256 fingerprint of client ID, mailbox and authority. A changed
mailbox, client ID or tenant invalidates previous selection; moving the token file
alone does not. Missing/unknown selection fails before creating a delivery record.
The generic action approval fingerprint and the quote send fingerprint both bind
this argument. There is no default sender or fallback to the other account.

The named provider `microsoft-graph-mail-connections-v1` stores a versioned envelope
containing the selected connection fingerprint and the immutable Graph message ID
in both provider-reference fields. Sending and reconciliation unwrap that same
reference after restarts, regardless of configuration ordering. Removed or changed
connections stay unresolved; their credentials must be restored or the attempt
explicitly escalated. No token or mailbox address is encoded in the envelope.
Each connection has its own cache and token store; sending and reconciliation
share the cache only within that connection.

The existing deduplication rule remains stricter than sender choice: a second
attempt for the same quote revision, recipient and channel stays blocked even
when a different sender is selected. A sender switch cannot be used to resend.

**Migration:** resolve outstanding legacy `microsoft-graph-mail-v1` attempts before
switching an existing process to named mode. Legacy references do not identify a
mailbox and cannot safely be guessed into a named connection. Do not rename or
remove a connection with outstanding attempts.

### Remaining live commissioning gate

The setup success message means only that refresh and read-only access passed for
both accounts. Keep `JARVIS_OUTLOOK_ENABLED` absent/false until the authorised dev
stack is configured with reconciliation and the full named connection array.
Then commission each account separately using a non-customer test recipient:
create draft, persist reference, send through the existing approval boundary,
observe the immutable ID, and verify one terminal result and no duplicate send.
Check revoked credentials fail closed and selecting the other mailbox requires a
new approved action. Customer sending and production deployment remain separately
authorised. Issues #293, #294 and #297 stay open until their live evidence exists.

Microsoft references:

- [Authorization code and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Native localhost redirect matching](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
- [Single-user delegated consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-consent-single-user)
- [Tenant user consent settings](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)

### Verification directory boundary

The `verify` command applies the same current-user ownership and owner-only
POSIX directory check as onboarding, before reading or refreshing a credential.
A valid mode-0600 token does not make a shared or differently owned parent
directory safe. Rejected verification makes no Microsoft request and preserves
the existing token. Supported private directories still permit token rotation.

### Single-stack localhost callbacks

Onboarding attempts both IPv4 and IPv6 loopback listeners on the same port.
An unavailable family (`EAFNOSUPPORT` or `EADDRNOTAVAIL`) is skipped only when
`localhost` does not resolve to that family. This applies symmetrically to
IPv4-only and IPv6-only hosts. Failure to bind a family that localhost does
resolve to stops before consent and closes any listener already opened.

### Maintained implementation and regression coverage

- [Administrator provisioning](../../scripts/setup-outlook.ps1) owns registration,
  single-user consent and durable recovery of uncertain setup effects. Its
  [offline harness](../../scripts/test-outlook-setup.ps1) replaces Microsoft calls.
- [Browser onboarding](../../typescript/src/auth/outlookOnboarding.ts) owns PKCE
  and localhost callbacks; the [token store](../../typescript/src/auth/fileRefreshTokenStore.ts)
  owns private-file validation and durable credential publication.
- [Connection composition](../../typescript/src/auth/microsoftOutlookConnections.ts)
  selects the mailbox and routes persisted provider references;
  [runtime composition](../../typescript/src/auth/microsoftOutlookRuntime.ts)
  retains the legacy single-account path.
- [Onboarding regressions](../../typescript/tests/outlookOnboarding.test.ts) and
  [connection regressions](../../typescript/tests/microsoftOutlookConnections.test.ts)
  exercise the callback, token and sender-selection boundaries described above.

These source references identify the maintained paths. They are not live OAuth,
provider delivery or completion evidence.
