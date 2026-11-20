# Security halt (`npm run sec`)

The halt is the owner's stop switch for governed tool execution (#839). Run it from `typescript/` in a terminal:

```sh
npm run sec -- halt "why you are stopping it"
npm run sec -- status
npm run sec -- resume "why it is safe again"
```

## What it does

- `halt` writes `jarvis-security-halt.json` (mode 0600) in the data directory (`JARVIS_DATA_DIR`, else `typescript/data`). The command loads `.env.local` first, so it writes the same file the service reads.
- Before every governed tool execution, the running service reads that record. While halted, each new execution is refused with receipt status `blocked` and error code `safety-blocked`. The service doesn't need a restart; the next attempt sees the halt.
- The check runs before preflight and before the single-use claim, so a refused attempt consumes nothing. After `resume`, the same approved action can run.
- Dry runs stay available, and so do reads that don't go through tool execution.

## Fail closed

| Record                                            | Result  |
| ------------------------------------------------- | ------- |
| Missing                                           | Running |
| `state: "none"` (after `resume`)                  | Running |
| `state: "requested"` (after `halt`)               | Halted  |
| Unreadable, symlink, not a file, over 4 KB        | Halted  |
| Invalid JSON, or fields other than the known five | Halted  |

## What it does not do yet

- It doesn't cancel work already in flight, so `status` never claims a verified stop.
- It has no acknowledged or verified-stopped state, and no remote or voice trigger.
- The privileged-operation policy ([privileged-operation-policy](../architecture/privileged-operation-policy.md)) takes a halt state as input, but no broker feeds it this record yet.
