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
unavailable source is sent as the tool result and relayed verbatim.

Model text is checked deterministically before it is spoken. Every figure in the
reply (digits, spelled-out numbers, or a currency sign) must appear, with the
same unit class (money, percent, formatted, count), in a read-only answer the
service itself returned during that turn, so "3 unpaid invoices" never grounds
"$3"; otherwise the result is
`conversation-unavailable` with reason `ungrounded`. A reply that claims or
promises an action ("I've sent", "I'll book", "that's done") is replaced with
fixed wording that nothing was done, as is a passive completion ("has been
sent", "is booked") unless a query answer this turn used that same participle. These checks are pattern-based: they block
the obvious failure shapes, not every possible phrasing, which is why the model
also holds no capability to act.

The Anthropic adapter is the only current reasoner. Configuration is explicit
opt-in, and its request loop, timeout, call quota, input size and spoken output
are bounded. Model-initiated actions are outside this boundary and require a
separate reviewed change.
