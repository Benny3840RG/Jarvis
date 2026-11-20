# Security halt (`npm run sec`)

The halt is the owner's stop switch for governed tool execution (#839). Run it from `typescript/`:

```sh
npm run sec -- halt "why you are stopping it"
npm run sec -- status
npm run sec -- resume "why it is safe again"
```

While halted, the running service refuses new governed tool executions. It doesn't need a restart. Work already in flight is not cancelled, so `status` never reports a verified stop.

The behaviour, including what counts as halted when the record can't be read, is defined and tested in:

- `src/security/haltControl.ts` (the halt record)
- `src/actions/toolExecution.ts` (`haltGate` in `ToolExecutionService`)
- `src/tools/runSecurityHalt.ts` (this command)
- `tests/securityHalt.test.ts`
