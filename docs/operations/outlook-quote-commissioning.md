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
entry. The client-contact check still runs after that. Client contacts are plain
stored values, not MIME headers, so the kit does not decode RFC 2047 encoded words.
NFKC and format, bidi, and zero-width stripping repeat until the contact stops
changing. A `=`, `?`, `(`, `)`, `"`, or any character outside letters, digits,
space, and `. _ + - @ < > , ; : ' /` refuses the contact before a mailbox is read.
Parentheses and quotes are not comments or quoted local parts. That same string
is then used to extract one mailbox. Zero mailboxes are ignored when the text
has no address shape. Exactly one mailbox is compared in canonical form:
lowercase, with one `+tag` removed from every domain, and for `gmail.com` and
`googlemail.com` with dots removed from the local part and the domain mapped to
`gmail.com`. The configured recipient is canonicalised the same way. Equal
canonical mailboxes refuse the run. The folded contact, reduced to `a-z` and
`0-9`, also refuses when it contains the recipient's canonical local part and
the contact is not exactly that recipient. A phone number or a name that stays
inside the allowlist and has no mailbox does not abort the run. A value that
looks like an address but is not exactly one mailbox refuses the run. A `+tag`
is ignored for every domain when comparing the mailbox with client contacts. `JARVIS_OUTLOOK_COMMISSIONING_CONFIRM`
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

The JSON also has a `trace` object that records what the owner decision card
`outlook-evidence-acceptance` asks for (#866):

- `repeatSend`: the repeat send's own receipt (id, status, error code and times),
  not just the kit's assertion.
- `deliveries`: each delivery attempt's status and timestamps (created,
  execution started, reconciled), plus its ledger `transitions` in recorded
  order: `pending`, `executing`, `provider-reference`, `indeterminate`, then the
  terminal step. The recipient is not repeated here. Attempts recorded before
  the ledger kept history have no `transitions`.
- `reconciliation`: its attempt count and last error code. For example, a first
  attempt that saw `outlook-message-still-draft` before resolving.
- `sameMessageIdDraftToSent`: true when the reconciliation saw the message first
  as a draft, then resolved it as sent under the delivery's Graph id. This is
  behavioural evidence that the id stayed stable from Drafts to Sent Items. It is
  not a trace of the `Prefer: IdType="ImmutableId"` request header.
- `draftImmutableIdApplied`: true only when this delivery's `provider-reference`
  transition records that Graph answered draft creation with
  `Preference-Applied: IdType="ImmutableId"`. This is Graph's own confirmation
  of the request header. `false` means Graph did not confirm it, not that the
  header was missing.
- `workers`: every worker result, in order. The two parallel workers run first,
  while the delivery is still unresolved, then three sequential runs.
- `parallelRaceBeforeResolution`: true when the parallel pair ran first and at
  least one of them claimed the work. Two idle runs do not count as a race.
- `resolvedWorkerRuns`: how many worker runs resolved a record. More than one
  would be a duplicate terminal effect.

## End-to-end Beez Treez workflow proof

`npm run commission:beez-treez-workflow` runs the same kit with `--workflow`.
It has the same guards, approval and single send. It proves the Local V1
business path from the release plan through the HTTP API:

`enquiry → client → property → project/job → quote draft/edit/finalise/PDF → governed Outlook send → reconciliation → invoice draft → daily brief/HUD`

An enquiry needs a client, so the kit runs the steps in this order:

1. Read the brief counts.
2. Create the disposable client, a property for it, and an enquiry on that
   property.
3. Convert the enquiry to a project.
4. Create the quote on that project, then draft, edit, finalise and send it,
   and reconcile it as above.
5. Create an invoice draft from the quote, with the same line items and
   project.
6. Read back the enquiry, the daily brief and the HUD snapshot.

The evidence JSON gains a `workflow` object with the record ids, the brief
counts before and after, the HUD observation, and these `checks`:

- `enquiryOnProperty`: the enquiry is on the property the run created.
- `enquiryConverted` and `enquiryLinkedToProject`: the enquiry is `converted`
  and its `convertedProjectId` is the new project.
- `quoteOnProject`: the quote carries the project id.
- `sendReconciledSucceeded`: the sent delivery reconciled as `succeeded`.
- `invoiceDraftFromQuote` and `invoiceOnProject`: the invoice is a draft that
  references the quote and the project.
- `invoiceCarriesQuoteLines`: the line items the invoice API returned match the
  finalised quote revision's line items, as that API returned them, field by
  field. Empty lists on both sides do not count.
- `briefCountsDraftInvoice` and `briefCountsSentQuote`: the brief's draft
  invoice count and sent quote count both rose during the run.
- `briefShowsQuoteAwaitingResponse`: the brief lists this quote as awaiting a
  response.
- `hudShowsQuoteOnProject`: the HUD snapshot's quote register is ready and
  lists this quote on the project.

`workflow.proven` is true only when every check holds. Each check is read from
what the API returned. An unavailable brief count or HUD fails its check; it is
never assumed. In workflow mode the kit writes the evidence either way, then
exits nonzero unless `workflow.proven` is true and names each broken check. A
failed send or reconcile still fails the run as before.

No Graph message is sent by installing this command. The host run is still
required, and it must not target a customer mailbox.
