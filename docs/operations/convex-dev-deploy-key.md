# Convex development deployment with a scoped key

This wrapper targets only `dev:outgoing-ram-798` at
`https://outgoing-ram-798.convex.cloud`. Deployment credentials are separate from
`JARVIS_SERVICE_TOKEN`, which authenticates the running application.

Run from `typescript/` in the exact reviewed checkout:

```bash
node scripts/convex-deploy-dev-outgoing-ram-798.mjs --dry-run
# After Benny approves the exact commit and displayed change plan:
node scripts/convex-deploy-dev-outgoing-ram-798.mjs --deploy
node scripts/convex-deploy-dev-outgoing-ram-798.mjs --verify
```

The script resolves the checkout from its own location. There are no target
flags. It never merges, approves a candidate, reconciles mission state or resets
worker/review attempts.

## Preflight and verification

`--dry-run` invalidates any previous receipt **before** checking the working tree,
credentials or provider. A successful preflight writes a versioned receipt bound
to the exact Git SHA, target URL and SHA-256 digest of the validated structured
Convex finish diff. The receipt expires after twenty minutes. It proves that a
preflight ran; it is **not owner approval**.

`--deploy` consumes the receipt, validates its schema, target, SHA and timestamp,
and refuses missing, malformed, future-dated or expired evidence. It runs another
non-deploying preflight and requires the same structured plan before invoking the
mutating command. The checkout is checked again and the receipt must still be
within its lifetime after that preflight. No automatic retry occurs after any
failure. Repeat the dry run and obtain a fresh exact-candidate decision when the
candidate or plan changes.

`--verify` requires structured evidence of **no pending changes**, including
functions and indexes. A successful CLI exit or a matching URL alone is
insufficient. Missing, ambiguous or unsupported diff output fails closed.
Verification writes no receipt and does not establish application functionality,
mission reconciliation, CI, peer review or Jarvis PASS.

The parser uses the installed Convex CLI's verbose `finishPushDiff` shape. It
accepts root-component function changes and index additions/enabling; it refuses
module/index removal, index disabling, schema/runtime/auth/cron changes and
component lifecycle changes. Those broader changes need separately scoped
preparation. Unknown diff fields fail closed rather than being discarded.
Only the validated finish diff and concise results are printed; raw verbose
provider output and errors are withheld.

**Concurrency limit:** the CLI recomputes its push after preflight. The wrapper
cannot atomically lock Convex against another deployment. Keep other deployment
writers stopped from approved preflight through deployment and verification.
The preflight is not a transactional guarantee against concurrent remote changes.
A failed mutating invocation has an uncertain outcome until independent readback;
never interpret a post-execution refusal as proof that nothing changed.

## Credential handling

- Store one line, `CONVEX_DEPLOY_KEY=dev:outgoing-ram-798|...`, in
  `~/.local/state/jarvis-convex/dev-outgoing-ram-798.env`.
- The state directory must be owned by the current user with mode `0700`; the
  key and receipt must be owned regular files with mode `0600`. Symlink files
  and a symlink state directory are refused before provider access.
- Provisioning is a separate owner operation. The CLI supports saving a scoped
  token directly to the file without printing it:

  ```bash
  node node_modules/convex/bin/main.js deployment token create <name> \
    --deployment-name outgoing-ram-798 \
    --save-env ~/.local/state/jarvis-convex/dev-outgoing-ram-798.env
  ```

- Never resolve deployment credentials from `~/.convex/config.json` or pass
  secrets through `--admin-key` or other command arguments. The wrapper injects
  only the scoped key and a small environment allowlist into the CLI; unrelated
  application secrets and `NODE_OPTIONS` are excluded.
- Rotate with a new scoped token and revoke the former token through the
  existing owner-controlled mechanism. Do not paste keys into chat or logs.

Convex CLI/API 1.45.0 does not offer a deploy-only permission. This key can also
run functions and read/write data on its one deployment. The restriction is to
one development deployment, not to deployment operations alone.

## Retired flow

The former personal-token/admin-key scripts remain in the local
`553-recovery-evidence/deprecated-admin-key-flow/` audit folder. Do not run them
for new deployments.
