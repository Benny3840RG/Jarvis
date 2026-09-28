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
  "--property=User=<the account Jarvis runs as>",
  "--property=IPAddressDeny=any",
  "--property=IPAddressAllow=127.0.0.1/32 ::1/128",
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
  "--property=LoadCredential=jarvis-acp-anthropic-key:/home/<user>/.config/jarvis/credentials/anthropic-acp-worker-key.cred",
  "--setenv=PATH=/usr/bin:/bin",
  "--setenv=JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL=jarvis-acp-anthropic-key",
  "--setenv=JARVIS_ACP_ANTHROPIC_PROXY_URI=http://127.0.0.1:<egress-proxy-port>",
  "--",
  "/usr/bin/node","--import","tsx","/path/to/pinned/release/typescript/src/acp/main.ts"
]
```

(JSON array on one line in the real env var; expanded here for readability.
`--pipe` is what keeps `stdin`/`stdout` connected to the pipes Jarvis created
while still running the worker as a sandboxed transient **service** — a
prerequisite for the namespace/filesystem/privilege directives above to take
effect. Do **not** substitute `--scope`: it would preserve the pipes but silently
drop that sandbox, since systemd would not be the one exec'ing the worker.
Verify the resulting unit with `systemd-analyze security` / `systemctl show`.)

> **Verify before enabling.** `IPAddressAllow=127.0.0.1/32 ::1/128` +
> `IPAddressDeny=any` needs root to take effect (confirmed on this host: it is
> silently ignored under a rootless `systemd-run --user`, so `sudo`/a system
> unit is not optional here). It restricts the worker's egress to loopback —
> where the egress proxy below listens — and nothing else. Provision the
> worker's own credential and the egress proxy (next section) before enabling
> a mode above `disabled`.

## Egress: one designated proxy on loopback, nothing else

**Correction to an earlier draft of this runbook.** An earlier version of this
document proposed `PrivateNetwork=yes` + a proxy reachable via
`JoinsNamespaceOf=` ("Design A"). Building the actual proxy surfaced that this
does not work: `JoinsNamespaceOf=` makes the referencing unit join the
_referenced_ unit's namespace — so if the proxy also sets `PrivateNetwork=yes`
to create a namespace for the worker to join, the proxy is trapped inside that
same loopback-only namespace and **also** loses real internet access, which
defeats the point. Sharing a network namespace this way can only work with a
real bridge (a veth pair + routing), which is materially more host-networking
work than this deserves. **Do not use `PrivateNetwork=yes` for the worker.**

The design that actually works — and is what `JARVIS_ACP_WORKER_ARGS` above
sets up — has one designated egress path with zero drift risk:

1. **The worker never touches the real network directly.** `IPAddressDeny=any`
   - `IPAddressAllow=127.0.0.1/32 ::1/128` on the worker's own unit restricts it
     to the host's real loopback — nothing else, not the LAN, not the internet.
     Unlike a model-API CIDR allowlist, loopback never changes, so there is no
     drift to own or re-verify on a schedule.
2. **A single-purpose CONNECT proxy listens on that loopback**
   (`src/acp/nolanAnthropicEgressProxy.ts`, run via
   `jarvis-anthropic-egress-proxy.service` below). It tunnels — never
   TLS-terminates — to exactly one hard-coded destination,
   `api.anthropic.com:443`, and refuses every other CONNECT target before ever
   opening an outbound connection (see the module's own tests for the exact
   allow/deny behaviour: `tests/nolanAnthropicEgressProxy.test.ts`). The
   worker's own TLS client still negotiates end-to-end with the real Anthropic
   server through the tunnel, so the proxy never sees plaintext, headers, or
   the API key.
3. **The worker reaches the proxy via `undici`'s `ProxyAgent`**
   (`JARVIS_ACP_ANTHROPIC_PROXY_URI`, wired in
   `nolanAnthropicDecider.ts`) — a stable, documented API (verified against the
   installed package's own type definitions), not a hand-rolled transport.

### The egress proxy unit

Unlike the per-request worker, this is a normal **persistent** unit — start it
once, no `sudo` required (it needs no `IPAddressAllow`/`ProtectHome`/etc. of its
own beyond ordinary hardening, so a rootless `--user` unit is fine, mirroring
`jarvis-github-egress.service`):

```ini
# ~/.config/systemd/user/jarvis-anthropic-egress-proxy.service
[Unit]
Description=Nolan ACP worker egress proxy (CONNECT-tunnels to api.anthropic.com:443 only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node --import tsx /path/to/pinned/release/typescript/src/acp/proxyMain.ts
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
UMask=0077
Environment=JARVIS_ACP_ANTHROPIC_EGRESS_PORT=<egress-proxy-port>

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now jarvis-anthropic-egress-proxy.service
```

(`src/acp/proxyMain.ts` reads `JARVIS_ACP_ANTHROPIC_EGRESS_PORT`, refuses to
start without a valid fixed port — `0`/ephemeral is rejected on purpose, since
other units need a known port to reference — and binds
`createAnthropicEgressProxyServer()` to `127.0.0.1` only. Covered by
`tests/nolanAnthropicEgressProxyMain.test.ts` as a real subprocess.)

Optional additional hardening: `IPAddressDeny=any` + `IPAddressAllow=<Anthropic's
current published CIDRs>` on the proxy's own unit, as coarse defense-in-depth on
top of (never instead of) its hostname-exact CONNECT check. As with any
CIDR-based control: do not hard-code ranges from memory, and own the drift.

Do **not** grant the worker or the proxy Jarvis's API tokens. Pass only the
worker's own Anthropic key, via `LoadCredential=` as shown above — never
`JARVIS_GITHUB_TOKEN`, `JARVIS_SERVICE_TOKEN`, the read-plane App key, or
`$CREDENTIALS_DIRECTORY` from Jarvis's own service.

## Worker lifecycle (avoid orphaned services) — verify, don't assume

The transport spawns a fresh child **per request** and calls `kill()` on it when
the request settles (response, timeout, flood, or crash). With `systemd-run
--pipe` the process the transport spawns and kills is the `systemd-run`
**client**, not the transient **service** it launched. Killing the client does
**not** necessarily stop the service, so without a lifecycle tie repeated
consultations could orphan worker services until `RuntimeMaxSec` — defeating
per-request cleanup and the resource bounds.

Do not assume any particular kill-propagation; establish and **verify** the
lifecycle on the host. Two backstops, layered:

1. **Worker exits on EOF / after one response.** `nolan-acp-worker`'s loop ends
   when its stdin closes, and per request it needs to emit at most one response.
   When the client is killed its stdio pipes close, so the service's stdin should
   reach EOF and the worker should exit on its own. Confirm this actually happens
   for your worker binary (a worker that ignores stdin EOF will linger).
2. **`RuntimeMaxSec` is the hard cap.** Set it (the example uses `120`) so even a
   worker that ignores EOF is reaped by the manager. Treat it as the ceiling, not
   the normal path.

If neither reliably stops the service promptly, prefer a lifecycle-tied launcher
(e.g. verify whether `systemd-run --pipe` on your systemd version stops the unit
when the client dies, or wrap so the unit is `systemctl stop`ped on client exit)
before enabling live worker launches. Add this to the verification checklist:
after several consultations — including a forced mid-request kill — confirm **no
orphaned worker unit or process remains** (e.g. `systemctl list-units 'run-*.service'`
and a process scan for the worker command) beyond the moment the request settled.

## Directive reference (what each does, and the caveats)

| Directive                                                                                                                             | Effect                                                                                                     | Caveat / verify                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrivateNetwork=yes`                                                                                                                  | Worker gets an isolated netns (loopback only) — no host/LAN.                                               | **Do not use for the worker** (see "Egress" above): sharing this with a proxy via `JoinsNamespaceOf=` traps the proxy in the same loopback-only namespace too, so it also loses real internet access. Needs a real veth bridge to work, which this runbook does not build. |
| `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1/32 ::1/128`                                                                           | Deny-by-default egress; allow only the host's real loopback (filters the existing, non-private interface). | **The recommended worker egress control.** No drift risk (unlike a model-API CIDR allowlist — loopback never changes). Root-only: confirmed silently ignored under a rootless `systemd-run --user` on this host. systemd ≥235 + cgroup v2/BPF.                             |
| `PrivateTmp=yes`                                                                                                                      | Private `/tmp`, `/var/tmp`.                                                                                | —                                                                                                                                                                                                                                                                          |
| `ProtectSystem=strict`                                                                                                                | Whole filesystem read-only except explicit `ReadWritePaths`.                                               | Give a small `ReadWritePaths=` scratch only if the worker needs one.                                                                                                                                                                                                       |
| `ProtectHome=yes`                                                                                                                     | `/home`, `/root`, `/run/user` inaccessible.                                                                | —                                                                                                                                                                                                                                                                          |
| `NoNewPrivileges=yes`                                                                                                                 | No setuid/gain-privilege via exec.                                                                         | —                                                                                                                                                                                                                                                                          |
| `CapabilityBoundingSet=` (empty)                                                                                                      | Drops all capabilities.                                                                                    | Empty value = none; verify the worker needs none.                                                                                                                                                                                                                          |
| `RestrictAddressFamilies=AF_INET AF_INET6`                                                                                            | Only IP sockets; blocks AF_UNIX/AF_NETLINK/etc.                                                            | If the worker must reach a proxy over a UNIX socket, add `AF_UNIX`.                                                                                                                                                                                                        |
| `SystemCallFilter=@system-service`                                                                                                    | Allowlist syscall set; denies the rest (with `EPERM`).                                                     | Test the worker actually runs under it; add groups only as needed.                                                                                                                                                                                                         |
| `SystemCallArchitectures=native`                                                                                                      | Blocks non-native ABIs (defeats some sandbox escapes).                                                     | —                                                                                                                                                                                                                                                                          |
| `MemoryMax` / `TasksMax` / `RuntimeMaxSec`                                                                                            | Resource + wall-clock bounds.                                                                              | `RuntimeMaxSec` kills long calls; set above the transport's response timeout.                                                                                                                                                                                              |
| `LoadCredential=` / `--setenv`                                                                                                        | Provide the worker's own API key out of band.                                                              | Prefer `LoadCredential` so keys aren't in argv/`systemctl show` env.                                                                                                                                                                                                       |
| `ProtectProc=invisible`, `ProtectKernelTunables=yes`, `ProtectControlGroups=yes`, `LockPersonality=yes`, `MemoryDenyWriteExecute=yes` | Further hardening.                                                                                         | Optional; some may break specific runtimes — test.                                                                                                                                                                                                                         |

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

- args, so no code change is required.

## Verification (prove it, don't assume it)

Before enabling live worker launches, confirm on the target host:

1. **No broad egress, and only the proxy path reaches Anthropic.** From inside
   the worker's `IPAddressAllow=127.0.0.1/32 ::1/128` sandbox: a direct
   connection to any non-loopback host must fail (`systemd-run --pipe
--property=User=<jarvis-user> --property=IPAddressDeny=any
--property=IPAddressAllow=127.0.0.1/32 ::1/128 … -- curl -sS --max-time 5
https://example.com` → must fail); a CONNECT through the egress proxy to
   `api.anthropic.com:443` must succeed; a CONNECT through the same proxy to any
   other host must be refused (403) without the proxy ever dialing out — this
   is exactly what `tests/nolanAnthropicEgressProxy.test.ts` already proves
   offline, so this step is confirming the _deployed_ proxy + sandbox combo
   behaves the same way, not re-deriving new evidence. (Use `--pipe`, not
   `--scope` — see the note above on why a scope silently drops the sandbox.)
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
- **DNS — resolved by this design, not just mitigated.** The worker only ever
  dials the literal IP `127.0.0.1`; it never resolves `api.anthropic.com`
  itself, and `IPAddressAllow=127.0.0.1/32 ::1/128` blocks outbound DNS queries
  (UDP/TCP 53 to any configured nameserver) along with everything else. Only
  the egress proxy resolves the real hostname.
- **Shared kernel.** systemd sandboxing is not a VM boundary. For hostile-tenant
  threat models, prefer a VM/microVM per worker.

## Enabling the consultation (operating mode)

The worker launch config above is _how_ a worker is sandboxed and launched; it is
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
- Gate D (real worker) code: `typescript/src/acp/nolanAnthropicDecider.ts` (the
  Anthropic-backed decider), `typescript/src/acp/main.ts` (the per-request
  worker entrypoint), `typescript/src/acp/nolanAnthropicEgressProxy.ts` (the
  CONNECT-only egress proxy), `typescript/src/acp/proxyMain.ts` (its
  entrypoint) — and their tests, `tests/nolanAnthropicDecider.test.ts`,
  `tests/nolanAcpWorkerMain.test.ts`, `tests/nolanAnthropicEgressProxy.test.ts`,
  `tests/nolanAnthropicEgressProxyMain.test.ts`.
- Architecture: `typescript/docs/architecture/acp-transport-seam.md`,
  `typescript/docs/architecture/acp-governed-consultation.md`.
- Evidence + gate status: `docs/operations/acp-commissioning-evidence.md`.
- Precedent: PR F's deny-by-default egress boundary
  (`typescript/docs/architecture/github-read-plane-boundary.md`).
