# Security Policy

Jarvis is a governed assistant platform with local HTTP/MCP surfaces, Convex persistence, Outlook/Graph integration work, and automation workflows. Treat security reports as production-impacting even while development commissioning is still gated.

## Supported scope

Security review currently covers the `main` branch and active pull requests targeting `main`.

The following areas are in scope:

- GitHub Actions workflows and autonomous build controls under `.github/`
- HTTP and MCP operator boundaries under `typescript/src/http` and `typescript/src/mcp`
- Authentication, OAuth, token storage, and Outlook/Microsoft Graph integrations under `typescript/src/auth` and `typescript/src/quotes`
- Convex persistence functions under `typescript/convex`
- Backup, restore, smoke-test, commissioning, and operational scripts
- Traceability, registry, validator, and security documentation that governs runtime behaviour

Historical prototypes, parked dashboard shells, or obsolete scaffolds are not supported unless they are still reachable from active workflows, packages, or runtime entry points.

## Reporting a vulnerability

Open a private security advisory on GitHub where possible. If private advisories are not available, create a minimal public issue that says a security report is available without disclosing exploit details, secrets, tokens, payloads, or reproduction steps.

Include:

- affected component and file path
- exact branch, commit, PR, or release observed
- impact and attacker capability required
- safe reproduction notes, with secrets redacted
- whether the issue affects local-only development, delegated OAuth, Convex persistence, GitHub Actions, or any future remote gateway

Do not post real credentials, Outlook refresh tokens, Convex deploy keys, OpenAI API keys, service tokens, customer data, or live mailbox contents.

## Response expectations

Security reports are triaged before feature work of equal priority. Critical reports affecting credential disclosure, unauthorised execution, remote exposure, duplicate sending, or data loss should block deployment until remediated or explicitly risk-accepted by the owner.

Expected handling:

1. Confirm receipt and affected scope.
2. Reproduce or reject with evidence.
3. Patch in the smallest safe PR.
4. Verify with tests, CI, smoke tests, or runtime proof.
5. Update the relevant backlog, matrix, runbook, or security report.

## Current security gates

- Non-loopback HTTP and MCP exposure remains blocked until the approved OAuth/OIDC, TLS, and remote gateway boundary exists.
- Development commissioning is guarded by exact confirmation text, repository secrets, loopback binding, Convex deployment identity checks, and smoke tests.
- Production deployment is not authorised from CI unless the human owner gives an explicit deployment approval gate.
- GitHub Actions should be pinned to full commit SHAs, and checkout credentials should not persist unless a job explicitly needs to push.
- Control-plane files require CODEOWNERS coverage.

## Out of scope for public disclosure

The following should not be publicly disclosed before remediation:

- token values, key material, or credential file contents
- live customer or mailbox data
- unpublished operational URLs, one-shot trigger contents, or recovery material
- exploit chains that enable unauthorised sends, state mutation, or autonomous workflow escalation