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
  "--property=PrivateNetwork=yes",
  "--property=IPAddressDeny=any",
  "--property=RestrictAddressFamilies=AF_UNIX",
  "--property=PrivateTmp=yes",
  "--property=ProtectSystem=strict",
  "--property=ProtectHome=yes",
  "--property=NoNewPrivileges=yes",
  "--property=CapabilityBoundingSet=",
  "--property=SystemCallFilter=@system-service",
  "--property=SystemCallArchitectures=native",
  "--property=MemoryMax=1G",
  "--property=TasksMax=64",
  "--property=RuntimeMaxSec=120",
  "--property=LoadCredentialEncrypted=jarvis-acp-anthropic-key:/home/<user>/.config/jarvis/credentials/anthropic-acp-worker-key.cred",
  "--setenv=PATH=/usr/bin:/bin",
  "--setenv=JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL=jarvis-acp-anthropic-key",
  "--setenv=JARVIS_ACP_ANTHROPIC_PROXY_SOCKET=/run/jarvis-acp/egress.sock",
  "--",
  "/usr/bin/node","--import","tsx","/path/to/pinned/release/typescript/src/acp/main.ts"
]
```

(JSON array on one line in the real env var; expanded here for readability.
`--pipe` keeps `stdin`/`stdout` connected to the pipes Jarvis created while still
running the worker as a sandboxed transient **service** — a prerequisite for the
namespace/filesystem/privilege directives above to take effect. Do **not**
substitute `--scope`: it would preserve the pipes but silently drop that sandbox,
since systemd would not be the one exec'ing the worker. Verify the resulting unit
with `systemd-analyze security` / `systemctl show`.)

**This is the recommended, gap-closing design (see Egress below):**
`PrivateNetwork=yes` gives the worker its **own empty network namespace** — only
a private loopback, no host loopback, no LAN, no internet — so it cannot reach
*any* host TCP service, including sibling localhost services. Its sole egress is
one **unix-domain socket** (`JARVIS_ACP_ANTHROPIC_PROXY_SOCKET`), a filesystem
object the worker connects to (`AF_UNIX` is the only address family it needs); the
worker never resolves DNS or opens a TCP socket itself. `IPAddressDeny=any` is
belt-and-suspenders under `PrivateNetwork`.

> **Verify before enabling.** Confirm on the host: (a) `PrivateNetwork=yes` took
> effect (`systemctl show <unit> -p PrivateNetwork`; it needs a system manager /
> `sudo`, not a rootless `--user` unit); (b) the worker can connect to the proxy
> socket but to **no other** localhost port (the probe in Verification below);
> and provision the worker's own credential and the egress proxy (next section)
> before enabling a mode above `disabled`.

## Egress: one designated proxy, and nothing else the worker can reach

The worker's only job is to reach exactly one destination, `api.anthropic.com:443`,
and nothing else — not the LAN, not the internet, and **not sibling services on
the host's loopback**. That last clause is the one an earlier draft got wrong;
two designs, recommended first.

### Recommended — `PrivateNetwork=yes` worker + unix-socket proxy (closes the sibling-localhost gap)

This is what `JARVIS_ACP_WORKER_ARGS` above sets up.

1. **The worker has its own empty network namespace.** `PrivateNetwork=yes`
   gives it a private loopback and no other interface at all — so it cannot open
   a TCP connection to any host address, including `127.0.0.1:<anything>`. There
   is therefore no way for it to reach a sibling localhost service (a local
   Convex, an admin/debug port, a database), which IP-level allowlisting cannot
   prevent (see the alternative below).
2. **Its sole egress is one unix-domain socket.** A single-purpose CONNECT proxy
   (`src/acp/nolanAnthropicEgressProxy.ts`, run via
   `jarvis-anthropic-egress-proxy.service` below) listens on
   `/run/jarvis-acp/egress.sock` (`JARVIS_ACP_ANTHROPIC_EGRESS_SOCKET`). A unix
   socket is a filesystem object, not a network path, so it crosses the worker's
   network-namespace boundary; the worker connects to it with `AF_UNIX` (the only
   address family it needs) and never resolves DNS or opens a TCP socket. Gate the
   socket with its directory's ownership/permissions (a systemd `RuntimeDirectory`
   owned by the proxy, with the worker's user or a shared group granted access) —
   verify the worker can connect to it and to nothing else (Verification below).
3. **The proxy tunnels — never TLS-terminates — to exactly `api.anthropic.com:443`**
   and refuses every other CONNECT target before opening any outbound connection
   (`tests/nolanAnthropicEgressProxy.test.ts`). The worker's TLS client negotiates
   end-to-end with the real Anthropic server through the tunnel, so the proxy
   never sees plaintext, headers, or the API key.
4. **The worker reaches the proxy via `undici`'s `ProxyAgent`**
   (`JARVIS_ACP_ANTHROPIC_PROXY_SOCKET`, wired in `nolanAnthropicDecider.ts`
   through `proxyTls.socketPath` — a documented `buildConnector` option, verified
   against the installed undici by a runtime test:
   `tests/acpUnixSocketEgress.test.ts`). The CONNECT tunnel is dialed over the
   unix socket; TLS to the API still terminates end-to-end.

### Alternative — host-netns worker + loopback IP allowlist (has a known residual)

If a unix-socket proxy is not workable, the worker can instead run **without**
`PrivateNetwork` on the host network namespace, with `IPAddressDeny=any` +
`IPAddressAllow=127.0.0.1/32 ::1/128` and the proxy on TCP loopback
(`JARVIS_ACP_ANTHROPIC_EGRESS_PORT`, `JARVIS_ACP_ANTHROPIC_PROXY_URI=http://127.0.0.1:<port>`).

**Known residual — do not describe this as "only the proxy".** `IPAddressAllow`
filters by remote **IP, not port**, and it is the host's **shared** loopback, so
the worker can open **any** `127.0.0.1:<port>` — every sibling localhost service,
not just the proxy. This is acceptable only when the host runs no sensitive
loopback services the worker must not reach, or when it is paired with a
per-port egress firewall scoped to the worker's cgroup (nftables `socket cgroupv2`
or an eBPF filter allowing only the proxy's port) — `IPAddressAllow` alone cannot
express a port. `IPAddressAllow`/`IPAddressDeny` also need a system manager /
`sudo` to take effect (silently ignored under a rootless `--user` unit). Prefer
the recommended design; if you use this one, verify the residual with the
sibling-port probe in Verification and record the decision.

### The egress proxy unit

Unlike the per-request worker, this is a normal **persistent** unit. For the
recommended unix-socket design, run it as a **system** unit so the socket sits at
a stable host path both it and the (system, `PrivateNetwork`) worker can see, and
let systemd own the socket directory:

```ini
# /etc/systemd/system/jarvis-anthropic-egress-proxy.service
[Unit]
Description=Nolan ACP worker egress proxy (CONNECT-tunnels to api.anthropic.com:443 only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<a dedicated proxy account>
ExecStart=/usr/bin/node --import tsx /path/to/pinned/release/typescript/src/acp/proxyMain.ts
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=yes
UMask=0077
# RuntimeDirectory owns the socket dir under /run; RuntimeDirectoryMode=0750
# gives the shared group traverse (x) access to the dir. `Group=` sets the
# socket's group; proxyMain.ts then chmods the socket itself to 0660 so the
# worker's account — in that shared group — can connect (an AF_UNIX connect
# needs *write* on the socket), and nothing outside owner+group can. Do NOT
# rely on UMask for the socket mode: under UMask=0077 a Node-created socket is
# 0700 and the worker could not connect — the explicit 0660 chmod is what makes
# the shared-group design work.
RuntimeDirectory=jarvis-acp
RuntimeDirectoryMode=0750
Group=<group shared with the worker's account>
Environment=JARVIS_ACP_ANTHROPIC_EGRESS_SOCKET=/run/jarvis-acp/egress.sock

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-anthropic-egress-proxy.service
```

(`src/acp/proxyMain.ts` binds `createAnthropicEgressProxyServer()` to
`JARVIS_ACP_ANTHROPIC_EGRESS_SOCKET` when set — removing any stale socket first —
and otherwise to `127.0.0.1:JARVIS_ACP_ANTHROPIC_EGRESS_PORT`; it refuses to
start with neither set. It chmods the socket to **0660** (owner + group rw) so
the worker's shared group can connect despite a restrictive service umask; the
socket's *group* comes from the unit's `Group=`. Still **verify on the host**
that the worker's account can `connect()` the socket and that no other account
can — the code sets the mode, but the group membership and directory traversal
are the unit's job. Covered by `tests/nolanAnthropicEgressProxyMain.test.ts`
(asserts the socket is created group-rw) and `tests/acpUnixSocketEgress.test.ts`.)

For the **alternative** loopback design, run the proxy on TCP loopback instead —
`Environment=JARVIS_ACP_ANTHROPIC_EGRESS_PORT=<port>` (a rootless `--user` unit is
fine there, mirroring `jarvis-github-egress.service`) — and set the worker's
`JARVIS_ACP_ANTHROPIC_PROXY_URI=http://127.0.0.1:<port>`. Remember that design's
residual (the worker can reach every loopback service, not just the proxy).

Optional additional hardening: `IPAddressDeny=any` + `IPAddressAllow=<Anthropic's
current published CIDRs>` on the proxy's own unit, as coarse defense-in-depth on
top of (never instead of) its hostname-exact CONNECT check. As with any
CIDR-based control: do not hard-code ranges from memory, and own the drift.

Do **not** grant the worker or the proxy Jarvis's API tokens. Pass only the
worker's own Anthropic key, via `LoadCredentialEncrypted=` as shown above — never
`JARVIS_GITHUB_TOKEN`, `JARVIS_SERVICE_TOKEN`, the read-plane App key, or
`$CREDENTIALS_DIRECTORY` from Jarvis's own service.

### Provisioning the worker's own credential

Run this yourself, in your own terminal — never paste the plaintext key into a
chat, a commit, or any tool call; `systemd-ask-password` reads it without
terminal echo, and it goes straight into `systemd-creds encrypt`, never touching
a shell variable, argv, or a file on disk unencrypted:

```bash
mkdir -p ~/.config/jarvis/credentials
chmod 700 ~/.config/jarvis/credentials
systemd-ask-password "Anthropic ACP worker API key: " | \
  systemd-creds encrypt --name=jarvis-acp-anthropic-key - \
  ~/.config/jarvis/credentials/anthropic-acp-worker-key.cred
chmod 600 ~/.config/jarvis/credentials/anthropic-acp-worker-key.cred
```

`--name=` is not cosmetic: systemd embeds it in the ciphertext and checks it
against the unit's `LoadCredentialEncrypted=<name>:<path>` at load time
specifically so an encrypted credential can't be silently renamed and reused
for a different purpose — it must read exactly `jarvis-acp-anthropic-key` to
match the worker unit above.

This targets **system-level** decryption (no `--user`/`--uid=`), matching the
worker's launch as a system-scope transient unit (`sudo systemd-run`, no
`--user` — the same shape Gate C's probes were run and verified under, since
`IPAddressAllow`/`ProtectHome`/`CapabilityBoundingSet=` were confirmed silently
ignored under a rootless `systemd-run --user` on this host). This is a
different scope than `jarvis-github-minter.service`'s credential, which is a
`--user` unit — the two are unrelated and do not need to match.

Verify without ever printing the key: confirm it decrypts and check the byte
count looks like a real key, not its contents.

```bash
systemd-creds decrypt ~/.config/jarvis/credentials/anthropic-acp-worker-key.cred | wc -c
```

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
| `PrivateNetwork=yes`                                                                                                                  | Worker gets its own empty netns (private loopback only) — no host loopback, LAN, or internet.             | **The recommended worker egress control** (Egress → Recommended). The worker cannot reach any host TCP service, including sibling localhost services; its sole egress is a unix socket. Pair with a unix-socket proxy — **not** `JoinsNamespaceOf=` (that traps the proxy without internet; a veth bridge would be needed, which this runbook does not build). Needs a system manager / `sudo`. |
| `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1/32 ::1/128`                                                                           | Deny-by-default egress; allow the host's **shared** loopback (all ports).                                 | Alternative only (Egress → Alternative). **Not "only the proxy"**: filters by IP not port, so the worker can reach every `127.0.0.1:<port>` sibling service — pair with a per-port cgroup/nftables filter or accept the residual. No CIDR drift (loopback never changes). Root-only: silently ignored under a rootless `--user` unit. systemd ≥235 + cgroup v2/BPF. |
| `PrivateTmp=yes`                                                                                                                      | Private `/tmp`, `/var/tmp`.                                                                                | —                                                                                                                                                                                                                                                                          |
| `ProtectSystem=strict`                                                                                                                | Whole filesystem read-only except explicit `ReadWritePaths`.                                               | Give a small `ReadWritePaths=` scratch only if the worker needs one.                                                                                                                                                                                                       |
| `ProtectHome=yes`                                                                                                                     | `/home`, `/root`, `/run/user` inaccessible.                                                                | —                                                                                                                                                                                                                                                                          |
| `NoNewPrivileges=yes`                                                                                                                 | No setuid/gain-privilege via exec.                                                                         | —                                                                                                                                                                                                                                                                          |
| `CapabilityBoundingSet=` (empty)                                                                                                      | Drops all capabilities.                                                                                    | Empty value = none; verify the worker needs none.                                                                                                                                                                                                                          |
| `RestrictAddressFamilies=AF_INET AF_INET6`                                                                                            | Only IP sockets; blocks AF_UNIX/AF_NETLINK/etc.                                                            | If the worker must reach a proxy over a UNIX socket, add `AF_UNIX`.                                                                                                                                                                                                        |
| `SystemCallFilter=@system-service`                                                                                                    | Allowlist syscall set; denies the rest (with `EPERM`).                                                     | Test the worker actually runs under it; add groups only as needed.                                                                                                                                                                                                         |
| `SystemCallArchitectures=native`                                                                                                      | Blocks non-native ABIs (defeats some sandbox escapes).                                                     | —                                                                                                                                                                                                                                                                          |
| `MemoryMax` / `TasksMax` / `RuntimeMaxSec`                                                                                            | Resource + wall-clock bounds.                                                                              | `RuntimeMaxSec` kills long calls; set above the transport's response timeout.                                                                                                                                                                                              |
| `LoadCredentialEncrypted=` / `--setenv`                                                                                               | Provide the worker's own API key out of band.                                                              | Prefer `LoadCredentialEncrypted=` (an encrypted-at-rest file, via `systemd-creds encrypt`) so keys aren't in argv/`systemctl show` env.                                                                                                                                    |
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
   the recommended `PrivateNetwork=yes` worker sandbox (use `--pipe`, not
   `--scope`): a direct connection to any non-loopback host must fail
   (`systemd-run --pipe --property=User=<jarvis-user> --property=PrivateNetwork=yes
   … -- curl -sS --max-time 5 https://example.com` → must fail); a request through
   the egress proxy (its unix socket) to `api.anthropic.com:443` must succeed; a
   CONNECT through the same proxy to any other host must be refused (403) without
   the proxy ever dialing out — exactly what `tests/nolanAnthropicEgressProxy.test.ts`
   and `tests/acpUnixSocketEgress.test.ts` prove offline, so this step confirms
   the _deployed_ proxy + sandbox behave the same, not new evidence.
1a. **No sibling localhost service is reachable (the gap this design closes).**
   From inside the same sandbox, a connection to another loopback port — pick a
   real one on the host, e.g. Jarvis's own local HTTP/MCP port — **must fail**:
   `systemd-run --pipe --property=User=<jarvis-user> --property=PrivateNetwork=yes
   … -- curl -sS --max-time 3 http://127.0.0.1:<some-other-local-port>/` → must
   fail (no host loopback in the worker's netns). Under the **alternative**
   loopback design this probe would instead **succeed** — that is the documented
   residual; if you run the alternative, record that you accept it (or that a
   per-port cgroup/nftables filter blocks it).
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

Record the results; a launch config that has not passed 1, 1a, and 2–4 must not
be enabled.

## Residual risks / what still needs a decision

- **Sibling localhost services (closed by the recommended design, open in the
  alternative).** `PrivateNetwork=yes` removes the host loopback from the worker
  entirely, so it cannot reach any `127.0.0.1:<port>` sibling service — this is
  why it is recommended. The `IPAddressAllow=127.0.0.1/32` alternative does **not**
  close this (IP, not port granularity); use it only where no sensitive loopback
  service exists or a per-port cgroup/nftables filter is added, and record the
  decision. Probe 1a is the check.
- **Hostname-precise egress** is not achievable with `IPAddressAllow` alone; the
  CONNECT proxy's hard-coded `api.anthropic.com:443` target is the robust "only
  this host" control. Any CIDR allowlist you add as defense-in-depth carries
  drift — own the re-verification.
- **The model API key is a real secret in the worker.** Its blast radius is the
  worker's model access; keep it distinct from Jarvis's tokens and rotate
  independently.
- **DNS — resolved by this design, not just mitigated.** The worker never
  resolves `api.anthropic.com`: it sends the hostname literally to the proxy over
  the unix socket, and the proxy resolves and dials it. Under `PrivateNetwork=yes`
  the worker has no route for outbound DNS at all; under the loopback alternative,
  `IPAddressDeny=any` blocks it too. Only the egress proxy resolves the hostname.
- **Socket reachability/permissions are host-verified, not code-enforced.** The
  code creates the socket; whether exactly the worker's account (and no other)
  can `connect()` it depends on the `RuntimeDirectory`/group setup — confirm it.
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
