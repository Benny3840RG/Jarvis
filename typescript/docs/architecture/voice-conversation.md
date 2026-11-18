# Voice conversation boundary

`VoiceController.dispatch` first awaits the existing `VoiceSession.handle` decision.
Only a final, wake-authorised `unrecognized` result with no pending confirmation
or clarification is offered to the optional `VoiceConversationService`. A null
service leaves voice responses unchanged. The model never receives a session
mutator, `ToolActionService`, hardware provider, or approval capability.

`VoiceConversationService` retains bounded user and assistant turns in a
`WeakMap` keyed by the existing `VoiceSession`. The registry's removal callback
clears and aborts that context on end, expiry, or eviction; the registry sweeps
expired sessions on an unref'd timer (default every 60 s) that exists only while
sessions exist, so expiry does not wait for another request and an idle registry
is never retained by a timer. `VoiceSessionRegistry.dispose()` (called when the
HTTP app closes) stops the timer and drops all sessions. A profile switch also clears it. A later final utterance on the
same session interrupts an in-flight reply, and the controller's liveness check
(same session, no pending confirmation or clarification) is re-run before every
query, every extra model call and the reply. For example, an unknown `Nolan how many unpaid invoices do I
have?` may prompt the model to call the single `voice_query` tool with
`client.unpaid-invoices`. The answer comes from `VoiceSession.readOnlyQuery`,
which uses the same provider and spoken result as the catalogue command. An
unavailable source is sent to the model as the tool result, but the turn then
fails closed (see below); the model's wording is never spoken.

Speech is bounded by one non-semantic rule (`speechDecision`). Model text is
never spoken; the model only chooses which read-only query to run.

| Query attempts this turn                   | Outcome                                           |
| ------------------------------------------ | ------------------------------------------------- |
| none                                       | fixed "I haven't done anything" reply, `answered` |
| more than one (any outcome)                | `unavailable`, `tool-limit`                       |
| one, source unavailable or refused         | `unavailable`, `unavailable`                      |
| one, answered, longer than the reply limit | `unavailable`, `reply-too-long`                   |
| one, answered, within the limit            | the exact answer, verbatim                        |

An authoritative answer is never truncated, shortened or reworded, and an
earlier unrelated answer cannot stand in for a later failed one. The model also
holds no capability to act. The HUD shows a fixed notice for each unavailable
reason.

The Anthropic adapter is the only current reasoner. Configuration is explicit
opt-in, and its request loop, timeout, call quota, input size and spoken output
are bounded. Model-initiated actions are outside this boundary and require a
separate reviewed change.
