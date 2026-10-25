# Security education — development slice for #732

This is a native Jarvis ToolAction capability, not another assistant or an execution framework.
AM-014 and AM-015 remain **planned** until separately reviewed, commissioned and authorised.
No deployment or production configuration is part of this change.

## Use the existing approval path

Use the authenticated project tool-action proposal, inspection, human approval and execute
routes documented in [tool-action-approval.md](tool-action-approval.md). Propose with
`tool: "security"`, `requiredAuthority: "T1"`, `destructive: false`, plus the normal project
revision, action ID, rationale and idempotency metadata. The approval token remains a
separate human-held credential. Education does not auto-approve anything.

Supported operations and argument objects:

- `explain`: `{"topic":"ports"}`. Topics: `ports`, `dns`, `tls`, `phishing`,
  `permissions`, `least-privilege`. A fixed reviewed catalogue; no free-form prompt.
- `interpret`: `{"format":"port-states","output":"22/tcp open ssh\n443/tcp closed https"}`.
  Paste only port-state rows, optionally preceded by `PORT STATE SERVICE`.
  This is a port-state excerpt parser, not a complete Nmap report interpreter.

Interpretation accepts TCP/UDP ports 1–65535 and states `open`, `closed`, `filtered`,
`unfiltered`, `open|filtered`, `closed|filtered`. Input is limited to 8192 characters
and 128 unique port/protocol rows. It rejects mixed reports, headers containing
hosts, duplicate rows, control sequences and arbitrary text as unsupported. A
short optional service label is discarded; a port number does not prove service identity.

The authoritative proposal mutation replaces accepted text with canonical port/protocol/state
rows **before storage and approval**. Unsupported text becomes `[unsupported]`, not a stored
copy of the pasted content. Review the stored proposal, not the original paste. Do not paste
credentials or personal data into the rationale, IDs or other ordinary proposal metadata.
No system can recognise every secret disguised as a valid port number or topic.

A successful execute response includes transient `education` with `version`, `supported`,
`summary` and `limitations`. `supported: false` means no diagnostic conclusion, even though
the educational action itself succeeded. Approval refusal, invalid arguments, timeout and
dry-run responses have no education answer. No raw supplied strings are returned.

The existing receipt persists its usual metadata and output digest only. The answer is
reconstructed locally and returned only when its digest matches the successful receipt.
Retries use the normal receipt replay. If the lesson/parser changes after execution and
changes the answer, an old receipt remains digest-only; stage and approve a fresh action.
There is no new database field or backup version. JSON-only runtime remains unsupported
for governed ToolActions, as before. No standalone MCP tool, voice route or HUD control is added.

## Limits and recovery

This slice cannot execute commands, read files, resolve names, scan networks, load URLs,
use an LLM, contact providers or approve follow-up work. Pasted instructions have no control
channel. All results describe supplied observations, not a verified machine state or a
vulnerability finding. Unsupported input gives a fixed explanation rather than a guess.

There are no diagnostic targets, DNS resolution, symlink reads or subprocesses to constrain
in this stage. Future diagnostics require separate scope, IPv4/IPv6, DNS-rebinding,
path/traversal, rate, timeout, cancellation and authority proof before activation.

Rollback is an owner-approved return to the previous application revision; do not rewrite
stored actions or receipts. Unregistered security operations then fail closed. Revoke pending
approvals through the existing consent lifecycle if required. Nothing was deployed by this PR.
