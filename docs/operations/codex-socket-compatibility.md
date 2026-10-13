# Codex worker socket isolation

## Upstream v1.13 startup validation

Both worker workflows use `openai/codex-action` commit
`bdf19a4a223ec2549a3e2274a0cf61556bc07675` (v1.13). Upstream now supplies the
worker-only, descriptor-pinned socket ACL restriction and effective-access
verification that the v1.12 compatibility patch repaired. The local bundle
rewriter is retired; the action bundle runs unmodified.

Before either worker starts, `verify-codex-action.mjs` derives the downloaded
action path from its canonical commit and verifies the complete bundle SHA-256:
`24b4bb0de44d67b2c2ed15f9e780f93887c5bfe688445e00d0bd5de4b380a232`.
The hash was calculated from `dist/main.js` at that immutable upstream commit.
Missing, altered, non-regular or symlinked bundle files stop startup. Validation
is read-only and repeatable. ACL tooling is still installed before `drop-sudo`.

The required automation-policy job checks out that same upstream commit. It
executes both workflow preparation commands in a disposable Actions directory
layout and requires the bundle to remain byte-for-byte unchanged. Contract
tests bind both `uses` references, the startup verifier and the Linux fixture
checkout together so a future dependency update cannot silently test an old
action while running a new one.

The socket tests execute the unmodified bundled discovery, restriction and
root/unprivileged verification helpers. Disposable Linux fixtures check worker
denial for original and fallback identities while unrelated service permissions
remain intact. OS-boundary tests supplement those fixtures; they do not replace
real socket and ACL evidence. No test touches host service sockets, invokes a
model, mutates sudoers, or claims production commissioning.

Upgrade the immutable workflow pin, canonical validation hash and fixture ref
together, inspect upstream security changes, and run the startup and Linux
socket tests before merging. Do not bypass a hash failure or restore the old
patch against an unreviewed bundle. Owner merge/deployment decisions and the
separate independent model-review quota remain distinct gates.

## Historical v1.12 repair

Issue #462 tracks a Linux isolation defect in the pinned Codex action:
its root phase changes shared service sockets to owner-only permissions.
That also removes access from unrelated Ubuntu service users. Retained Jarvis
logs confirm the operation; missing logs prevent attributing each cancelled
worker to it conclusively. See [upstream issue #160](https://github.com/openai/codex-action/issues/160).

Before the v1.13 update, the build applied a compatibility patch only to the
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

Retirement of this compatibility layer requires the upstream replacement to
pass the same isolation and service-access checks. Never use unsafe mode,
restore worker sudo, or roll back security controls to recover throughput.
