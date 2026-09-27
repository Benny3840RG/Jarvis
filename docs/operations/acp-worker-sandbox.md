# ACP worker sandbox (operations runbook)

## What this is and why it exists

The ACP stdio transport (`typescript/src/acp/acpStdioTransport.ts`) launches a
local worker (Claude/Codex) as a child process and talks to it over stdin/stdout.
The **code** does two isolation things and no more:

- `buildAcpChildEnv` gives the child a minimal, allowlisted environment (PATH +
  explicit overrides only) — Jarvis's own `process.env`, including any
  credentials, is **not** inherited.
- The transport opens no network itself (no HTTP, no listeners, no ports).

The code **cannot** enforce, from Node:

- that the worker process reaches only the hosts it is allowed to reach;
- filesystem confinement, privilege reduction, or resource bounds on the worker.

Those are **host/provisioning** controls. This runbook is how an operator
provides them with systemd, analogous to how PR F's GitHub read plane relies on
the environment's egress policy rather than trusting the process alone.

> This is a provisioning guide, not code. Nothing here is auto-applied. Apply and
> **verify** it on the target host before enabling live ACP worker launches.

## The actual goal (read this first)

The worker is **not** "no network." A Claude/Codex worker needs to reach its own
model/API endpoint to function. Per the owner's decision, that model/API egress
is a **separate governed concern** and must be neither broadened nor removed by
the ACP work. So the goal is **deny-by-default egress with a narrow allowlist**,
not an air gap:

1. **Egress:** the worker may reach **only** its model API endpoint(s). No
   internal services, no cloud metadata endpoint (169.254.169.254), no arbitrary
   hosts, no localhost services it was not given.
2. **Credentials:** the worker gets **only** its own model API key, provisioned
   explicitly — never Jarvis's environment (already enforced in code; reinforced
   here).
3. **Filesystem:** read-only system, private/empty writable scratch, no access to
   Jarvis's working tree, secrets, or `$CREDENTIALS_DIRECTORY`.
4. **Privilege:** no new privileges, dropped capabilities, restricted syscalls.
5. **Bounds:** memory/CPU/task/time limits so a runaway worker cannot starve the
   host (the transport already bounds stdout bytes and applies a response
   timeout; this is the OS backstop).
6. **Do not break Jarvis.** Jarvis itself needs network (e.g. api.github.com for
   the read plane). Isolation must apply to the **worker**, not to the whole
   Jarvis service — see the architecture note below.

## Architecture: isolate the worker, not Jarvis

`spawnAcpChild` runs the worker as a child of the Jarvis process. If you sandbox
the **Jarvis** systemd service with `PrivateNetwork=yes`, you also cut off
Jarvis's own network — wrong. Two correct shapes:

- **Preferred — launch each worker as its own transient _service_.** Point the
  env-configurable worker command at `systemd-run --pipe`, wrapping the real
  worker, so the worker gets its **own** namespaces and sandbox independent of
  Jarvis. It must be a service, **not** a `--scope`: a scope adopts a process the
  caller already forked, so systemd never performs the exec and therefore
  **cannot** apply the namespace/filesystem/privilege sandbox
  (`PrivateNetwork`, `ProtectSystem`, `ProtectHome`, `RestrictAddressFamilies`,
  `SystemCallFilter`, …) — those directives are set only when systemd itself
  spawns the process. Only **cgroup-based** controls take effect for a scope:
  the resource limits (`MemoryMax`/`TasksMax`) **and** the BPF egress filters
  (`IPAddressAllow`/`IPAddressDeny`), which act on the cgroup rather than at
  exec time. The exec-time namespace/filesystem/privilege/seccomp controls do
  not — which is why a scope is not enough here. `--pipe` runs the worker as a
  transient service **and**
  wires its stdin/stdout/stderr to the pipes Jarvis created, so the framing
  channel still works. No code change is needed: `resolveAcpWorkerConfigFromEnv`
  already takes an arbitrary command + argv.
- **Alternative — a template unit** `acp-worker@.service` with the sandbox
  directives baked in, launched via `systemd-run --unit=` or `systemctl start`.
  Cleaner audit surface; slightly more moving parts.

Jarvis must have permission to create transient units (running as a systemd
service with an appropriate scope, or via a delegated slice). Verify this in your
deployment; if Jarvis cannot talk to systemd, use the `unshare`/`bwrap` fallback
below.

## Preferred pattern: `systemd-run` wrapper via worker env

Set the worker launch config (see `acpWorkerConfig.ts`) so the command is
`systemd-run` and the args carry the sandbox properties, then the real worker
after `--`:

```
JARVIS_ACP_WORKER_COMMAND=systemd-run
JARVIS_ACP_WORKER_ARGS=[
  "--pipe","--quiet","--collect",
  "--property=PrivateNetwork=yes",
  "--property=PrivateTmp=yes",
  "--property=ProtectSystem=strict",
  "--property=ProtectHome=yes",
  "--property=NoNewPrivileges=yes",
  "--property=CapabilityBoundingSet=",
  "--property=RestrictAddressFamilies=AF_INET AF_INET6",
  "--property=SystemCallFilter=@system-service",
  "--property=SystemCallArchitectures=native",
  "--property=MemoryMax=1G",
  "--property=TasksMax=64",
  "--property=RuntimeMaxSec=120",
  "--setenv=PATH=/usr/bin:/bin",
  "--",
  "/usr/local/bin/acp-claude-worker","acp","--stdio"
]
```

(JSON array on one line in the real env var; expanded here for readability.
`--pipe` is what keeps `stdin`/`stdout` connected to the pipes Jarvis created
while still running the worker as a sandboxed transient **service** — a
prerequisite for the namespace/filesystem/privilege directives above to take
effect. Do **not** substitute `--scope`: it would preserve the pipes but silently
drop that sandbox, since systemd would not be the one exec'ing the worker.
Verify the resulting unit with `systemd-analyze security` / `systemctl show`.)

> **Incomplete as shown — do not copy-paste and enable.** This block is the
> isolation *skeleton*, not a runnable config: `PrivateNetwork=yes` gives the
> worker loopback only, so as written it **cannot reach its model API** and the
> worker will fail. You must add exactly one egress path — the filtering proxy
> (recommended) or the IP allowlist — from the **egress** section below, and
> provide the worker's own credential, before it works. It is written this way on
> purpose: start closed, open only the one path you need.

Key point about **egress**: `PrivateNetwork=yes` gives the worker an isolated
network namespace with only loopback — i.e. **no** external network at all. If
the worker needs to reach its model API, you must give it exactly that and
nothing else. `PrivateNetwork` alone cannot express "only api.anthropic.com," so
pair it with one of:

- **An egress proxy** the worker is forced through: put a filtering
  forward-proxy (allowlisting only the model API host) on a socket/address the
  worker's namespace can reach (e.g. via `JoinsNamespaceOf=` a proxy unit, or a
  slirp/veth bridge to the proxy only), and set the worker's `HTTPS_PROXY` to it.
  This is the most robust "only this host" control and mirrors the read plane's
  hard-coded origin. **Recommended.**
- **IP allowlisting** with `IPAddressDeny=any` +
  `IPAddressAllow=<model-API CIDRs>` (systemd ≥235, cgroup v2 / BPF). Honest
  limitation: this is **IP/CIDR**-based, not hostname-based, so it depends on the
  provider's published egress ranges and drifts as they change — treat it as
  coarse defense-in-depth, not a precise host allowlist. **Do not** hard-code
  CIDRs from memory; take them from the provider's current published ranges and
  re-verify on a schedule.

Do **not** grant the worker Jarvis's API tokens. Pass only the worker's own key
explicitly, e.g. add `"--setenv=ANTHROPIC_API_KEY=..."` sourced from the worker's
**own** credential (ideally a systemd `LoadCredential=`/`--property=LoadCredential=`
so it isn't visible in the process args or the unit's environment dump). Never
pass Jarvis's `JARVIS_GITHUB_TOKEN`, `JARVIS_SERVICE_TOKEN`, read-plane App key,
or `$CREDENTIALS_DIRECTORY` through.

## Directive reference (what each does, and the caveats)

| Directive                              | Effect                                                        | Caveat / verify                                                                 |
| -------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `PrivateNetwork=yes`                   | Worker gets an isolated netns (loopback only) — no host/LAN.  | Blocks the model API too; must pair with a reachable filtering proxy (above).   |
| `IPAddressDeny=any` + `IPAddressAllow` | Deny-by-default egress; allow named CIDRs.                    | systemd ≥235 + cgroup v2/BPF; **IP/CIDR only**, not hostnames; ranges drift.     |
| `PrivateTmp=yes`                       | Private `/tmp`, `/var/tmp`.                                    | —                                                                               |
| `ProtectSystem=strict`                 | Whole filesystem read-only except explicit `ReadWritePaths`.  | Give a small `ReadWritePaths=` scratch only if the worker needs one.            |
| `ProtectHome=yes`                      | `/home`, `/root`, `/run/user` inaccessible.                   | —                                                                               |
| `NoNewPrivileges=yes`                  | No setuid/gain-privilege via exec.                            | —                                                                               |
| `CapabilityBoundingSet=` (empty)       | Drops all capabilities.                                       | Empty value = none; verify the worker needs none.                               |
| `RestrictAddressFamilies=AF_INET AF_INET6` | Only IP sockets; blocks AF_UNIX/AF_NETLINK/etc.           | If the worker must reach a proxy over a UNIX socket, add `AF_UNIX`.             |
| `SystemCallFilter=@system-service`     | Allowlist syscall set; denies the rest (with `EPERM`).        | Test the worker actually runs under it; add groups only as needed.              |
| `SystemCallArchitectures=native`       | Blocks non-native ABIs (defeats some sandbox escapes).        | —                                                                               |
| `MemoryMax` / `TasksMax` / `RuntimeMaxSec` | Resource + wall-clock bounds.                             | `RuntimeMaxSec` kills long calls; set above the transport's response timeout.   |
| `LoadCredential=` / `--setenv`         | Provide the worker's own API key out of band.                 | Prefer `LoadCredential` so keys aren't in argv/`systemctl show` env.            |
| `ProtectProc=invisible`, `ProtectKernelTunables=yes`, `ProtectControlGroups=yes`, `LockPersonality=yes`, `MemoryDenyWriteExecute=yes` | Further hardening. | Optional; some may break specific runtimes — test.                              |

## Fallback without systemd

If Jarvis cannot use systemd (containers, non-systemd hosts), wrap the worker with
`unshare`/`bwrap` instead, keeping the same goals:

- `unshare --net` (isolated netns) + a proxy the worker can reach, or run the
  worker inside a container with an egress network policy allowlisting the model
  API only.
- `bwrap --unshare-all --share-net --ro-bind / /` … `--clearenv --setenv PATH …`
  for filesystem + env confinement, combined with a container/host egress
  firewall for the network allowlist.

The exact wrapper is again just the env-configurable `JARVIS_ACP_WORKER_COMMAND`
+ args, so no code change is required.

## Verification (prove it, don't assume it)

Before enabling live worker launches, confirm on the target host:

1. **No broad egress.** From inside the sandbox, a connection to a
   non-allowlisted host fails. E.g. wrap a probe as the worker command once:
   `systemd-run --pipe --property=PrivateNetwork=yes … -- curl -sS --max-time 5 https://example.com` → must fail; the model API host → must succeed only through the intended proxy/allowlist. (Use `--pipe`, not `--scope`, or the `PrivateNetwork` sandbox will not actually apply and the probe would falsely "pass.")
2. **No cloud metadata.** `curl -sS --max-time 3 http://169.254.169.254/` from
   inside the sandbox must fail.
3. **No Jarvis credentials.** Dump the worker's environment from inside the
   sandbox (`env`) and confirm none of `JARVIS_GITHUB_TOKEN`,
   `JARVIS_SERVICE_TOKEN`, the read-plane App key, or `$CREDENTIALS_DIRECTORY`
   appears. Only PATH and the worker's own key should be present.
4. **Filesystem confinement.** Confirm the worker cannot read the Jarvis working
   tree or secrets (attempt a read; expect failure).
5. **Bounds active.** `systemd-analyze security <unit>` (for a named unit) and a
   review of `systemctl show` for the transient **service** (the `--pipe` unit);
   confirm MemoryMax/TasksMax/RuntimeMaxSec are set.
6. **Jarvis unaffected.** Jarvis's own network still works (e.g. the GitHub read
   plane can still reach api.github.com) — proving isolation is scoped to the
   worker, not the service.

Record the results; a launch config that has not passed 1–4 must not be enabled.

## Residual risks / what still needs a decision

- **Hostname-precise egress** is not achievable with `IPAddressAllow` alone; the
  proxy approach is the only robust "only this host" control. If you accept
  CIDR-based allowlisting, own the drift (scheduled re-verification).
- **The model API key is a real secret in the worker.** Its blast radius is the
  worker's model access; keep it distinct from Jarvis's tokens and rotate
  independently.
- **DNS.** If the worker resolves names, ensure DNS goes through the same
  controlled path (the proxy, or a pinned resolver), not an arbitrary one.
- **Shared kernel.** systemd sandboxing is not a VM boundary. For hostile-tenant
  threat models, prefer a VM/microVM per worker.

## Enabling the consultation (operating mode)

The worker launch config above is *how* a worker is sandboxed and launched; it is
still inert until an operating mode is set. `JARVIS_ACP_MODE` selects it:

- unset / `disabled` (default) — ACP is never consulted; no worker launches.
- `advisory` — the peer is consulted for evidence only; it can never grant
  authority or remove valid governed authority.
- `required` — the peer becomes an additional veto/availability gate; a `deny` or
  any classified failure blocks a governed-approved action (it still cannot grant
  authority).

Commission progressively: apply and **verify** this sandbox (Gate C) and
provision the worker credential + dry-run (Gate D) before setting a mode above
`disabled`, and start any live use at `advisory` on a low-consequence operation
(Gate E) — never `required` globally, and never merge/deploy authority. Rollback
is config-level: set `JARVIS_ACP_MODE=disabled` (or unset the worker command).

## Related

- Code side: `typescript/src/acp/acpStdioTransport.ts` (`buildAcpChildEnv`,
  `spawnAcpChild`), `typescript/src/acp/acpWorkerConfig.ts`
  (`resolveAcpWorkerConfigFromEnv`), `typescript/src/acp/acpOperatingMode.ts`
  (mode policy), `typescript/src/acp/acpGovernedConsultation.ts`.
- Architecture: `typescript/docs/architecture/acp-transport-seam.md`,
  `typescript/docs/architecture/acp-governed-consultation.md`.
- Evidence + gate status: `docs/operations/acp-commissioning-evidence.md`.
- Precedent: PR F's deny-by-default egress boundary
  (`typescript/docs/architecture/github-read-plane-boundary.md`).
