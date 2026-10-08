# Outlook quote commissioning (#294 and #297)

This kit is the operator run for one disposable quote on J-arvis. It does not
close #294 or #297. A passing JSON package is evidence for Benny to read; both
issues stay open until that host run is reviewed.

Run it once, on the host, against the pinned development deployment and a
mailbox that is not a customer. The kit refuses `JARVIS_ENVIRONMENT=production`,
a `CONVEX_DEPLOYMENT` that is not `dev:` plus one deployment slug, a
`CONVEX_URL` whose host is not loopback or exactly `https://<slug>.convex.cloud`
(plaintext cloud hosts are refused), a
non-loopback Jarvis API, a recipient that is missing the `non-customer`
confirmation, a recipient that is not on the allowlist, or a recipient that
matches a client contact. Those checks happen before a quote is created.

The recipient is `JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT`. It must already be a
plain `local@domain` mailbox. Comparison lowercases and trims, and then rejects
quotes, comments, encoded words, display names, and trailing dots instead of
repairing them. The allowlist is
`JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST`, a comma-separated list of
those same plain mailboxes in the shell or ignored `.env.local`. A missing or
empty allowlist refuses the run, and the recipient must exactly match one
entry. The client-contact check still runs after that. It normalises the contact
with NFKC, then extracts every email-like token, including an address in
parentheses or angle brackets. A phone number or a name with no mailbox does
not abort the run. A value that looks like an address but is not exactly one
mailbox refuses the run. A contact that is that mailbox, or whose text contains
the recipient, also refuses the run. A `+tag` is ignored only when comparing the
mailbox with client contacts. `JARVIS_OUTLOOK_COMMISSIONING_CONFIRM`
must be exactly `non-customer`. `JARVIS_OUTLOOK_COMMISSIONING_PROJECT_KEY` must
already be a Convex totality project. This kit does not create that project.
The project is read before any client or quote is created. A missing project
stops the run with nothing written.

From `typescript/`, with Jarvis HTTP already listening on loopback and
reconciliation enabled:

```sh
npm run commission:outlook-quote
```

Required environment (shell or ignored `.env.local`, never a command argument):

- `JARVIS_ENVIRONMENT=development`
- `CONVEX_DEPLOYMENT=dev:...` (an unquoted trailing `#` comment is stripped; a comment glued to the slug is refused)
- `CONVEX_URL` loopback, or exactly `https://<slug>.convex.cloud` for `dev:<slug>`
- `JARVIS_API_BASE_URL` loopback
- `JARVIS_RECONCILIATION_ENABLED=true`
- `JARVIS_SERVICE_TOKEN`
- `JARVIS_APPROVAL_TOKEN`
- `JARVIS_OUTLOOK_COMMISSIONING_PROJECT_KEY`
- `JARVIS_OUTLOOK_COMMISSIONING_CONFIRM=non-customer`
- `JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT`
- `JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST` (comma-separated plain mailboxes; required)
- the existing Outlook runtime variables that register `quotes:send`
- `JARVIS_OUTLOOK_COMMISSIONING_CONNECTION` when named Outlook connections are enabled (the connection id, such as `personal`). Legacy single-mailbox mode must omit it.

`CONVEX_DEPLOYMENT` may include one unquoted trailing comment, for example
`dev:outgoing-ram-798 # note`. Node's `.env.local` parser drops that comment.
A systemd EnvironmentFile keeps it. The kit strips the same comment before the
development check and passes the stripped value to reconciliation, so both
sources name one deployment. Quoted values are left whole. `prod:... # note`
is still refused. `dev:slug#note` is refused because the `#` is not preceded by
whitespace.

When `JARVIS_OUTLOOK_CONNECTIONS_JSON` is set, the kit stages `quotes:send`
with that connection's `senderConnection` fingerprint. There is no default
connection. The approval step is unchanged: it still posts the existing
approval token and does not add another approver.

A personal Microsoft account (the consumers authority, no tenant id) is
addressed as Graph `/me`. Before any mailbox call, every non-empty `mail`
and `userPrincipalName` on the signed-in profile must equal the configured
mailbox after trim, compared case-insensitively. Both empty, or one of them
different, fails closed. An unreadable profile fails closed. Work or school
mailboxes stay on `/users/{mailbox}`.

The command uses the existing HTTP routes and the existing Outlook
reconciliation worker:

1. Read clients. Skip a phone or name that contains no mailbox. Refuse when a
   contact looks like an address but is not exactly one mailbox, or when that
   mailbox is the recipient.
2. Resolve the named sender, require the Outlook runtime and reconciliation,
   and require the totality project. A missing project creates no client and
   no quote.
3. Create a disposable client with no email contact, then a quote draft.
4. Edit the draft, review it, and finalise it.
5. Stage, approve, and execute governed `quotes:send` on the supplied totality
   project. Named mode includes the sender fingerprint in the staged
   arguments. Approval uses the existing approval token. The command does not
   invent another approver.
6. Read the immutable Graph message id from the execution receipt
   (`providerRequestId`).
7. Run the existing reconciliation worker three times, then twice in parallel.
8. Stage and execute a second `quotes:send` for the same finalized revision and
   recipient. That execution must come back `failed` or `blocked`, and the
   delivery ledger must still contain one attempt.
9. Run the worker again, sequentially and in parallel, then require exactly one
   `resolved` reconciliation for that message id.

Stdout is one JSON object. `issues` is `{ "294": "OPEN", "297": "OPEN" }` and
`satisfied` is `false`. Set `JARVIS_OUTLOOK_COMMISSIONING_EVIDENCE` to an
absolute path outside the repository to also write that JSON with mode `0600`.
Do not commit the package. A nonzero exit means the proof failed; it is not a
successful send.

No Graph message is sent by installing this command. The host run is still
required, and it must not target a customer mailbox.
