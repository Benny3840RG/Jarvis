# Guarded voice commissioning

This runbook commissions the browser/HUD voice path from speech or typed input to the Jarvis voice HTTP boundary. It does **not** prove physical equipment control. Main uses `AbsentHardwareProvider`, so every actuation target must remain unavailable until a separately reviewed hardware adapter is installed and commissioned.

## Preconditions

1. Work from the exact PR candidate SHA being evaluated.
2. Run `npm run check` and `npm run openapi:lint` from `typescript/`; both must pass.
3. Start the local preview with `npm run start:preview` and open the HUD on the loopback address it reports.
4. Do not expose the preview to a non-loopback interface merely to test voice. Off-loopback voice routes retain normal service-token/OIDC authentication.

## Browser and typed checks

1. Open **Voice**. Record browser/OS and whether the HUD reports **MIC AVAILABLE** or **TYPED ONLY**.
2. With no microphone enabled and the **Client** profile selected, type a read-only command such as `any unpaid invoices`. A healthy empty invoice register is reported as none, not as a guessed count. If the invoice register cannot be read, the HUD names invoice records as unavailable. Recognizing the command must never be presented as an answered business query when its source is unavailable. Live workshop, crawler and trailer hardware status stays unavailable until a hardware adapter is commissioned. Recorded crawler or trailer status, when the build register can be read, names only builds whose kind records that equipment.
3. Type an unknown phrase. Confirm it is rejected/unrecognised and nothing becomes pending.
4. Select **Crawler** and submit `crawler halt`. Confirm the HUD enters **awaiting confirmation**. Submit `cancel`; confirm the pending command clears without actuation.
5. Repeat `crawler halt`, then submit `confirm`. On the uncommissioned main hardware provider the result must be **actuation unavailable / failed closed**. Any successful actuation acknowledgement at this stage is a stop condition.
6. Change profile while a critical command is pending. Confirm the pending confirmation is invalidated and the microphone is aborted. Enable the microphone again explicitly to resume recognition in the acknowledged profile.
7. Select **Workshop**, submit `start the compressor`, then `stop the compressor`. Confirm the earlier start is no longer pending and a later `confirm` does nothing.
8. Interrupt a dispatch or recognition with **Stop**. Confirm buffered recognition and late responses cannot dispatch, restore pending state or restart speech. Already-submitted server operations cannot be undone by stopping the browser.
9. Change profile while session creation or a dispatch is in flight. Confirm old responses do not restore the previous profile or pending state. A failed profile switch must block dispatch until a profile is selected again and acknowledged.
10. After an expired-session response, submit a fresh command. Confirm a new session is created without replaying the failed utterance or carrying over its pending confirmation.

## Microphone checks

Only run these when the browser reports speech recognition support and the operator explicitly presses **Enable microphone**.

1. Speak a command without the wake word. It must not dispatch.
2. Speak `Jarvis crawler status` after selecting **Crawler**. Only a final recognition result may dispatch.
3. Arm a critical command with `Jarvis crawler halt`, then use `Jarvis cancel`; confirm it disarms.
4. Arm it again and use `Jarvis confirm`; with no hardware adapter the result must still fail closed.
5. Press **Stop** while recognition or TTS is active. Confirm recognition is aborted and speech output is cancelled, including final results or responses arriving after the button press.

## Latency evidence

The HUD's **Dispatch round-trip** value is measured in the browser from the moment Jarvis begins a final typed/speech dispatch until the voice response JSON is received and parsed. The first dispatch may include voice-session creation. Commands are serialized; time spent waiting behind an earlier command is excluded. It is **not** speech-recognition latency, network-wide tracing, hardware actuation timing, or a claim about recognition accuracy.

Record at least 10 observed dispatch samples with the browser/host and candidate SHA. Report the raw values plus median and worst observed value. There is deliberately no invented pass threshold: establish a baseline on the actual Jarvis host before setting one.

## Pass / stop conditions

Pass only when the maintained CI is green, the OpenAPI contract lints, the voice HUD works through typed fallback, wake-word/final-only behaviour is correct where speech recognition exists, confirmation replay/profile-change cases fail closed, and absent hardware never acknowledges actuation.

Stop commissioning if a partial/ambiguous utterance actuates, spoken confirmation bypasses the governed action boundary, a pending confirmation survives profile/reset/manual override, a remote unauthenticated request reaches a voice route, or unavailable hardware reports success.
