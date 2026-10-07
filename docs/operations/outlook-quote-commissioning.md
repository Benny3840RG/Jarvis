# Outlook quote commissioning (#294 and #297)

This kit is the operator run for one disposable quote on J-arvis. It does not
close #294 or #297. A passing JSON package is evidence for Benny to read; both
issues stay open until that host run is reviewed.

Run it once, on the host, against the pinned development deployment and a
mailbox that is not a customer. The kit refuses `JARVIS_ENVIRONMENT=production`,
a `CONVEX_DEPLOYMENT` that is not `dev:` plus one deployment slug, a
`CONVEX_URL` whose host is not loopback or exactly `https://<slug>.convex.cloud`
(plaintext cloud hosts are refused), a
non-loopback Jarvis API, and a recipient that is missing the `non-customer`
confirmation or that matches a client contact. Those checks happen before a
quote is created.

The recipient is `JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT`. It must be an email
address. Display names, `mailto:`, case, and one trailing dot are folded away,
and that exact mailbox is what the quote uses. A `+tag` is ignored only when
comparing the mailbox with client contacts. `JARVIS_OUTLOOK_COMMISSIONING_CONFIRM`
must be exactly `non-customer`. `JARVIS_OUTLOOK_COMMISSIONING_PROJECT_KEY` must
already be a Convex totality project. This kit does not create that project.

From `typescript/`, with Jarvis HTTP already listening on loopback and
reconciliation enabled:

```sh
npm run commission:outlook-quote
```

Required environment (shell or ignored `.env.local`, never a command argument):

- `JARVIS_ENVIRONMENT=development`
- `CONVEX_DEPLOYMENT=dev:...`
- `CONVEX_URL` loopback, or exactly `https://<slug>.convex.cloud` for `dev:<slug>`
- `JARVIS_API_BASE_URL` loopback
- `JARVIS_RECONCILIATION_ENABLED=true`
- `JARVIS_SERVICE_TOKEN`
- `JARVIS_APPROVAL_TOKEN`
- `JARVIS_OUTLOOK_COMMISSIONING_PROJECT_KEY`
- `JARVIS_OUTLOOK_COMMISSIONING_CONFIRM=non-customer`
- `JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT`
- the existing Outlook runtime variables that register `quotes:send`

The command uses the existing HTTP routes and the existing Outlook
reconciliation worker:

1. Read clients and refuse if the recipient is one of their contacts.
2. Create a disposable client with no email contact, then a quote draft.
3. Edit the draft, review it, and finalise it.
4. Stage, approve, and execute governed `quotes:send` on the supplied totality
   project. Approval uses the existing approval token. The command does not
   invent another approver.
5. Read the immutable Graph message id from the execution receipt
   (`providerRequestId`).
6. Run the existing reconciliation worker three times, then twice in parallel.
7. Stage and execute a second `quotes:send` for the same finalized revision and
   recipient. That execution must come back `failed` or `blocked`, and the
   delivery ledger must still contain one attempt.
8. Run the worker again, sequentially and in parallel, then require exactly one
   `resolved` reconciliation for that message id.

Stdout is one JSON object. `issues` is `{ "294": "OPEN", "297": "OPEN" }` and
`satisfied` is `false`. Set `JARVIS_OUTLOOK_COMMISSIONING_EVIDENCE` to an
absolute path outside the repository to also write that JSON with mode `0600`.
Do not commit the package. A nonzero exit means the proof failed; it is not a
successful send.

No Graph message is sent by installing this command. The host run is still
required, and it must not target a customer mailbox.
