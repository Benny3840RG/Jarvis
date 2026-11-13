# Guarded voice commissioning

This runbook commissions the browser/HUD voice path from speech or typed input to the Jarvis voice HTTP boundary. It does **not** prove physical equipment control. Main uses `AbsentHardwareProvider`, so every actuation target must remain unavailable until a separately reviewed hardware adapter is installed and commissioned.

## Preconditions

1. Work from the exact PR candidate SHA being evaluated.
2. Run `npm run check` and `npm run openapi:lint` from `typescript/`; both must pass.
3. Start the local preview with `npm run start:preview` and open the HUD on the loopback address it reports.
4. Do not expose the preview to a non-loopback interface merely to test voice. Off-loopback voice routes retain normal service-token/OIDC authentication.

## Browser and typed checks

1. Open **Voice**. Record browser/OS and whether the HUD reports **MIC AVAILABLE** or **TYPED ONLY**.
2. With no microphone enabled and the **Client** profile selected, type a read-only command such as `Jarvis any unpaid invoices`. A healthy empty invoice register is reported as none, not as a guessed count. If the invoice register cannot be read, the HUD names invoice records as unavailable. Recognizing the command must never be presented as an answered business query when its source is unavailable. Live workshop, crawler and trailer hardware status stays unavailable until a hardware adapter is commissioned. Recorded crawler or trailer status, when the build register can be read, names only builds whose kind records that equipment.
3. Type an unknown phrase. Confirm it is rejected/unrecognised and nothing becomes pending.
4. A typed safe write (`Jarvis add a task`, `Jarvis remind me to follow up`) stages a ToolAction only when the utterance starts with `Jarvis`, a commissioned project target is supplied, and the capture includes the required title (and, for a task, a category). Punctuation or whitespace right after `Jarvis` (`Jarvis, add a task`, `Jarvis. add a task`, `Jarvis? add a task`) is the same wake word. A longer word such as `Jarvisx` is not. A missing or blank reminder title is incomplete and must write nothing. Without the wake word the phrase may be recognised and must write nothing. Spoken confirmation never approves a quote send, a draft, or any other consequential proposal. The microphone path keeps the stripped command and sends the original wake-word transcript as `heardTranscript`. Voice never approves or executes. The staged action id includes the expected project revision, so a retry of the same revision is the same proposal and a different revision is a different proposal.
   For inferred speech, only that accepted leading wake prefix is stripped before interpretation. `Jarvis I'd send the quote` and `Jarvis I'll send the quote` are reports: neither may leave a pending confirmation, and a later `confirm` must do nothing. `Jarvis, can you send the quote?` remains an explicit request that waits for spoken confirmation and then yields only a governed proposal.
5. Select **Crawler** and submit `Jarvis crawler halt`. Confirm the HUD enters **awaiting confirmation**. Submit `Jarvis cancel`; confirm the pending command clears without actuation.
   For a two-turn ambiguity, submit `Jarvis crawler forward and turn crawler lights on`, then `Jarvis the second one`. The second turn must enter **awaiting confirmation** for crawler lights and must not actuate yet. A later `Jarvis confirm` still uses the normal single-use confirmation path. The offered choices expire after the confirmation TTL and are discarded after one final follow-up, cancel, profile change, reset or manual override; a later ordinal alone must do nothing.
   While the choice is offered the HUD shows, and speaks through browser speech where available, a prompt that lists only the command ids the server returned, in the server's order, using catalog summaries for the active profile and the plain id otherwise (at most four are listed, then a count). The prompt is display only: it holds no choice and sends nothing, and the reply is an ordinary typed or final spoken utterance on the same session. The server response does not say whether a reply is still open, so the prompt always also allows repeating the full command. Stop, a profile change, a failed or expired session, or any other result replaces the prompt. Stop, a profile change and a failed or expired session also cancel the prompt's browser speech, so it cannot keep inviting a reply to a session that is gone. Confirm/cancel conflicts and ids outside the active profile's catalog are listed as conflicting with no invitation to choose, and a malformed candidate list shows the generic ambiguous message.
   A follow-up that names an opposite command, reports an action already taken, asks whether it happened, or conflicts with a recogniser alternative must leave no pending confirmation. After an offer expires, a fresh wake-authorised request follows the normal interpreter path on that same turn.
6. Repeat `Jarvis crawler halt`, then submit `Jarvis confirm`. On the uncommissioned main hardware provider the result must be **actuation unavailable / failed closed**. Any successful actuation acknowledgement at this stage is a stop condition.
7. Change profile while a critical command is pending. Confirm the pending confirmation is invalidated and the microphone is aborted. Enable the microphone again explicitly to resume recognition in the acknowledged profile.
8. Select **Workshop**, submit `Jarvis start the compressor`, then `Jarvis stop the compressor`. Confirm the earlier start is no longer pending and a later `Jarvis confirm` does nothing.
9. Interrupt a dispatch or recognition with **Stop**. Confirm buffered recognition and late responses cannot dispatch, restore pending state or restart speech. Already-submitted server operations cannot be undone by stopping the browser.
10. Change profile while session creation or a dispatch is in flight. Confirm old responses do not restore the previous profile or pending state. A failed profile switch must block dispatch until a profile is selected again and acknowledged.
11. After an expired-session response, submit a fresh command. Confirm a new session is created without replaying the failed utterance or carrying over its pending confirmation.

## Microphone checks

Only run these when the browser reports speech recognition support and the operator explicitly presses **Enable microphone**.

1. Speak a command without the wake word. It must not dispatch. A safe write spoken without the wake word must not stage a task or reminder.
2. Speak `Jarvis crawler status` after selecting **Crawler**. Only a final recognition result may dispatch.
3. Arm a critical command with `Jarvis crawler halt`, then use `Jarvis cancel`; confirm it disarms.
4. Arm it again and use `Jarvis confirm`; with no hardware adapter the result must still fail closed. `Jarvis confirmed` is accepted as the same confirmation, because browsers often transcribe a spoken "confirm" that way. Sound-alikes such as `Jarvis concern` must be rejected and leave the confirmation pending.
5. Press **Stop** while recognition or TTS is active. Confirm recognition is aborted and speech output is cancelled, including final results or responses arriving after the button press.
6. Leave the microphone enabled and stay silent for a minute. The browser ends a listening session after a silence or a network interruption; the HUD starts a new one, so **Enable microphone** stays disabled and the next `Jarvis` command is still heard. Listening ends only on **Stop**, a profile switch, a refused microphone permission, or three sessions in a row that each end within two seconds. The last two show a notice that names the browser's reason.

## Latency evidence

The HUD's **Dispatch round-trip** value is measured in the browser from the moment Jarvis begins a final typed/speech dispatch until the voice response JSON is received and parsed. The first dispatch may include voice-session creation. Commands are serialized; time spent waiting behind an earlier command is excluded. It is **not** speech-recognition latency, network-wide tracing, hardware actuation timing, or a claim about recognition accuracy.

Record at least 10 observed dispatch samples with the browser/host and candidate SHA. Report the raw values plus median and worst observed value. There is deliberately no invented pass threshold: establish a baseline on the actual Jarvis host before setting one.

## Pass / stop conditions

Pass only when the maintained CI is green, the OpenAPI contract lints, the voice HUD works through typed fallback, wake-word/final-only behaviour is correct where speech recognition exists, confirmation replay/profile-change cases fail closed, and absent hardware never acknowledges actuation.

Stop commissioning if a partial/ambiguous utterance actuates, spoken confirmation bypasses the governed action boundary, a voice write approves or executes itself, a quote send or other consequential proposal creates an effect, a pending confirmation survives profile/reset/manual override, a remote unauthenticated request reaches a voice route, or unavailable hardware reports success.
