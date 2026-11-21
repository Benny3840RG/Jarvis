# Security halt (`npm run sec`)

The halt is the owner's stop switch for governed tool execution (#839). Run it from `typescript/`:

```sh
npm run sec -- halt "why you are stopping it"
npm run sec -- status
npm run sec -- resume "why it is safe again"
```

While halted, the running service refuses new governed tool executions and cancels the ones in flight. It doesn't need a restart. `halt` waits up to 5 seconds for the service, then prints one of three states:

- **not acknowledged**: the service hasn't seen the halt. It may not be running.
- **acknowledged**: the service saw this halt and cancelled its running executions, but at least one provider call hasn't finished yet.
- **verified stopped**: nothing the service started is still running.

Cancelling sends the provider an abort. A provider that ignores aborts can't be forced to stop, so it keeps the state at acknowledged until it finishes. A cancelled execution ends with an unknown outcome (`indeterminate`), so check what it did before retrying it. A single-use approval cancelled after it was claimed stays used up and needs approving again. The states only cover governed tool executions inside the HTTP service process.

`GET /api/v1/status` reports the same state as `securityHalt`, without your reason text. The overall status is `degraded` while dispatch is refused.

The HUD shows a halt as follows:

- The status pill reads **HALTED**, and presence reads **BLOCKED**.
- The backdrop goes to its stopped severity.
- The footer gives the stage: verified stopped, stopping (with how many are still running), not acknowledged, or cannot be verified.

The behaviour, including what counts as halted when the record can't be read, is defined and tested in:

- `src/security/haltControl.ts` (the halt record)
- `src/security/haltSupervisor.ts` (cancellation and the acknowledgement file)
- `src/actions/runningExecutions.ts` and `src/actions/toolExecution.ts` (how running executions are tracked and cancelled)
- `src/tools/runSecurityHalt.ts` (this command)
- `tests/securityHalt.test.ts` and `tests/securityHaltStop.test.ts`
