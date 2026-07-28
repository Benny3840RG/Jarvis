# Delegated Outlook runtime

Jarvis can compose the approved Microsoft Graph quote-mail provider and its reconciliation adapter for a personal Outlook account. The integration is disabled by default and this repository contains no Microsoft credential.

## Authority boundary

Repository composition does not authorise or perform Microsoft consent, a live token exchange, a customer email, or a production deployment. Those remain operator-controlled actions.

The runtime is limited to:

- delegated `Mail.ReadWrite` for creating and observing the immutable draft;
- delegated `Mail.Send` for sending that prepared draft;
- `offline_access` for background refresh and reconciliation;
- approved, finalised quote PDFs through the existing `quotes:send` allowlist.

It does not add general outbound email.

## Required configuration

Outlook composition requires all of the following:

| Variable | Requirement |
| --- | --- |
| `JARVIS_OUTLOOK_ENABLED` | Exact value `true`; absent or `false` keeps Outlook disabled |
| `JARVIS_OUTLOOK_CLIENT_ID` | Microsoft app registration client ID for the approved personal-account delegated flow |
| `JARVIS_OUTLOOK_MAILBOX` | Personal Outlook mailbox used by Graph |
| `JARVIS_OUTLOOK_REFRESH_TOKEN_FILE` | Absolute path to the runtime refresh-token file |

Background reconciliation is independently disabled unless `JARVIS_RECONCILIATION_ENABLED=true` and its existing Convex/service-token configuration is complete. Enabling reconciliation without an Outlook adapter fails startup before the listener is ready.

## Secret-file requirements

The refresh token is a runtime secret, never repository configuration.

- Keep its parent directory private and not group- or world-writable.
- Store the token in a regular file, not a symbolic link.
- Set the file to owner-readable only (for example mode `0600`).
- Keep the path absolute.
- Do not put the file in Git, application logs, backups, screenshots, or support bundles.

Jarvis reads the file without following symbolic links. Microsoft refresh-token rotation is written to an owner-only temporary file, flushed, atomically renamed, and directory-synced before the new access token is returned. Access tokens remain in process memory only.

## Runtime behaviour

The maintained HTTP and controlled-preview entrypoints create one Outlook runtime per process. Sending and reconciliation share its access-token cache.

A Graph `202 Accepted` response remains indeterminate. Jarvis does not report delivery from that response; the existing reconciliation worker observes the immutable message ID and records the terminal outcome.

Invalid booleans, incomplete enabled configuration, insecure token files, missing scopes, token rejection, and unavailable provider adapters fail closed with stable redacted error codes.

## Activation checklist

Before any live activation:

1. Register or select a Microsoft application that permits the personal account.
2. Review and grant only `Mail.ReadWrite`, `Mail.Send`, and `offline_access`.
3. Provision the refresh token through a separately approved consent workflow.
4. Install it at the configured owner-only path.
5. Validate in a non-production environment without a customer recipient.
6. Obtain separate approval for a live customer email.
7. Obtain separate approval for production deployment.

Do not combine consent, a live send, and deployment into one change window.
