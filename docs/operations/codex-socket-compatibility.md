# Codex worker socket compatibility repair

Issue #462 tracks a Linux isolation defect in the pinned Codex action:
its root phase changes shared service sockets to owner-only permissions.
That also removes access from unrelated Ubuntu service users. Retained Jarvis
logs confirm the operation; missing logs prevent attributing each cancelled
worker to it conclusively. See [upstream issue #160](https://github.com/openai/codex-action/issues/160).

Before the worker starts, the build applies a compatibility patch only to the
exact SHA-256-verified bundle from action commit
`86365089eb2b84e0a8fb0717b304f8bdcb13b20e`. It replaces the socket restriction
function and passes the original worker UID to it. Socket discovery also uses
the existing inode-pinned access probe for every potentially writable root
socket, including sockets whose group/other mode bits indicate write access.
The existing isolation strategy, capability removal, file-identity
checks, workspace controls, immutable diff guard, draft publication and
verification remain in force.

The replacement adds a deny ACL for that UID, without recalculating the mask.
It preserves the socket mode and unrelated ACL entries, then verifies the
result. The ACL commands operate through the pinned open file descriptor,
inherited as child fd 3, not a re-resolved socket pathname. Missing ACL tools
are installed before isolation. Hash, identity, ACL or verification errors
stop the job; there is no global chmod fallback.

The required automation-policy CI job runs the actual upstream and patched
functions against disposable Linux sockets, using the upstream descriptor
inheritance helper. It proves that the original denies an unrelated service
user, while the repaired version denies only the worker and preserves prior
ACL entries. Local OS-boundary tests are supplementary, not a substitute for
that real Linux permission test.

The first repair (#465) missed the interaction with root verification: discovery
treated group/other write bits as proof of worker access without checking its
deny ACL. Run 34092957935 applied the ACLs but stopped safely at the unchanged
root verifier before coding. The revised discovery probes the real worker UID
with both original and fallback groups; the final root and unprivileged
verifiers are unchanged. The Linux fixture executes that complete socket
discovery/restriction/verification sequence for world, supplementary-group,
named-ACL and fallback-group access. Accessible sockets must fail verification;
denied sockets must pass while an unrelated service UID retains access.
The fixture also reproduces #465's verifier failure and rejects subprocess
errors. It does not claim that a short successful run proves long-run reliability.

Do not rerun cancelled workers blindly. Record their missing stage evidence,
repair and review the cause, then start a fresh bounded mission on main.
An old workflow rerun does not adopt a newer workflow definition.

Remove this compatibility layer only when a reviewed upstream replacement
passes the same isolation and service-access checks. Never use unsafe mode,
restore worker sudo, or roll back security controls to recover throughput.
