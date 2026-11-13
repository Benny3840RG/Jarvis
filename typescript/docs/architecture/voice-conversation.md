# Voice conversation boundary

`VoiceController.dispatch` first awaits the existing `VoiceSession.handle` decision.
Only a final, wake-authorised `unrecognized` result with no pending confirmation
or clarification is offered to the optional `VoiceConversationService`. A null
service leaves voice responses unchanged. The model never receives a session
mutator, `ToolActionService`, hardware provider, or approval capability.

`VoiceConversationService` retains bounded user and assistant turns in a
`WeakMap` keyed by the existing `VoiceSession`. The registry's removal callback
clears and aborts that context on end, expiry, or eviction; a profile switch
also clears it. For example, an unknown `Nolan how many unpaid invoices do I
have?` may prompt the model to call the single `voice_query` tool with
`client.unpaid-invoices`. The answer comes from `VoiceSession.readOnlyQuery`,
which uses the same provider and spoken result as the catalogue command. An
unavailable source is sent as the tool result and relayed verbatim.

The Anthropic adapter is the only current reasoner. Configuration is explicit
opt-in, and its request loop, timeout, call quota, input size and spoken output
are bounded. Model-initiated actions are outside this boundary and require a
separate reviewed change.
