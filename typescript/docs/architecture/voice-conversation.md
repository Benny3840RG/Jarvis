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

Speech is bounded by one small, non-semantic rule (`boundedSpeech`). If any
read-only query answered during the turn, the model's text is discarded and the
exact authoritative answer(s) are spoken verbatim, in query order, duplicates
removed; the model only chooses which query to run, so it cannot change
polarity, entity, status, number, currency, unit or add a clause. If no query
answered (none made, or the source was unavailable), the model text is spoken
only when it is a bare greeting or a single short question (interrogative
opener from a closed list, one trailing "?", no digits, no commas or other
clause-chaining punctuation or conjunctions); anything else is replaced with a
fixed "I haven't done anything" reply. No fact, amount, schedule or action
outcome can be spoken without an authoritative answer. The model also holds no
capability to act. Reply length remains capped; truncation is at sentence
boundaries of the authoritative text.

The Anthropic adapter is the only current reasoner. Configuration is explicit
opt-in, and its request loop, timeout, call quota, input size and spoken output
are bounded. Model-initiated actions are outside this boundary and require a
separate reviewed change.
