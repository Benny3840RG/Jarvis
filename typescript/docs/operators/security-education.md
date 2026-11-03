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
- `interpret`: `{"format":"file-mode","output":"-rwxr-x---"}`.
  Supply one ten-character regular-file (`-`) or directory (`d`) symbolic mode.
  Surrounding ASCII spaces/tabs are accepted. Full listings, names, paths,
  symlink/device modes, octal modes, ACL markers, newlines and control characters
  are unsupported. Jarvis does not read the named file or run `ls`/`chmod`.

For example, `-rwxr-x---` explains owner read/write/execute, group read/execute,
and no permissions for others. `drwxrwxrwt` explains directory listing,
modification and traversal, plus sticky-bit restrictions on deletion/rename.
Lowercase `s`/`t` includes execute/traverse; uppercase `S`/`T` does not.
Setgid directories normally pass their group to new entries. Setuid directory
and sticky regular-file bits are normally ignored on Linux. ACLs, parent
permissions, mount options and identities still determine effective access.
No interpretation claims a file is safe or that a specific user can access it.

Interpretation accepts TCP/UDP ports 1–65535 and states `open`, `closed`, `filtered`,
`unfiltered`, `open|filtered`, `closed|filtered`. Input is limited to 8192 characters
and 128 unique port/protocol rows. It rejects mixed reports, headers containing
hosts, duplicate rows, control sequences and arbitrary text as unsupported. A
short optional service label is discarded; a port number does not prove service identity.

The authoritative proposal mutation replaces accepted text with canonical port/protocol/state
rows or a single canonical file-mode token **before storage and approval**. Unsupported text becomes `[unsupported]`, not a stored
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

## Numeric modes

Use `interpret` with `{"format":"file-mode-octal","kind":"file","output":"750"}`
for owner read/write/execute, group read/execute and no permissions for others.
Use `kind: "directory"` for directory semantics; the kind is required because
numeric permissions do not identify the object type. `1777` on a directory
explains sticky-bit restrictions, and `2750` explains group inheritance.

Accepts exactly three or four digits from 0–7 with optional ASCII spaces/tabs.
Three digits imply no special bits; canonical storage pads them to four digits.
No sign, `0o` prefix, command, filename, newline or guessed type is accepted.
This is educational interpretation, not a chmod operation or advice to change
permissions. The symbolic `file-mode` format continues to reject numeric input.

## Creation masks

Use `interpret` with `{"format":"umask","output":"022"}` to explain what
an illustrative `0666` file request and `0777` directory request become:
`0644` and `0755`. A mask removes bits; it cannot add execution permission to a
file request. Actual application requests and parent default ACLs can change
the result, so this is not a claim about a real file or your current process.
Existing permissions are unchanged. Jarvis does not set the process umask.

Accepts exactly three octal digits or four with leading zero; horizontal ASCII
padding is allowed. Canonical storage uses four digits. Special-bit masks,
commands, filenames, signs, prefixes and newlines are unsupported.

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

## Supplied creation request

Use the same governed interpret operation with:

    {"format":"creation-mode","kind":"file","requestedMode":"0660","output":"0027"}

Here output is the supplied umask, not a command result. Without a parent
default ACL, this request yields 0640: owner read/write, group read, others
none. Use kind directory for directory permission meanings. Both numeric
tokens accept three digits or four with a leading zero and ASCII space/tab
padding; proposals store four digits. Special bits, paths and commands are
unsupported. Missing kind or requestedMode is invalid.

Unlike the illustrative umask format, creation-mode uses the requested mode
you provide. A 0600 request with mask 0000 remains 0600; masks never grant bits.
This only calculates ordinary permission bits. Parent default ACLs, inherited
setgid and other system controls are outside the calculation. Jarvis neither
creates a file nor reads or changes your process mask or existing permissions.
