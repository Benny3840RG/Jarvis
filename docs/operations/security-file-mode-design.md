# Offline file-mode interpretation — #777

User direction: continue adding Jarvis features autonomously while owner-gated
work proceeds. Codex selected this small extension of #732's offline education
slice. It requires no new credentials, provider calls or paid model inference.

Reuse `security:interpret` with `format: file-mode`, a bounded string and the
existing T1 ToolAction lifecycle. Accept only a regular-file or directory mode
and horizontal ASCII padding; minimise to the canonical token before durable
staging. Invalid excerpts become the existing unsupported marker. Fixed text
explains access classes and special bits without echoing raw input or asserting
effective access. Full listings and octal input are deliberately unsupported.

A separate command, LLM interpreter or live filesystem reader would duplicate
existing paths or add unnecessary cost/access. The selected design extends the
existing deterministic parser and preserves old port-state output and receipts.
No persistence schema or new operation is needed. No new execution/approval path.

Verify via failure-first parser and hostile-input cases, real authenticated HTTP
execution, digest replay and Convex proposal minimisation tests, followed by the
maintained full check. Review and owner merge/deployment remain separate gates.
