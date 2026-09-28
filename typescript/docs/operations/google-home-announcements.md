# Governed Google Home / Nest announcements

NOLAN can emit a short spoken announcement to an explicitly pinned Google Cast device on the local LAN.

The capability is registered as the external operation `home:announce`. It does not expose a general Cast remote-control surface and does not bypass the existing ToolAction / ΩΣ claim, receipt, and reconciliation boundary.

## Transport

- mDNS discovery is read-only and uses `_googlecast._tcp`.
- Speech is synthesized locally on J-arvis with `text2wav` in a cancellable worker thread. The worker receives only the message and voice, not runtime environment credentials. It is terminated on cancellation, failure or its 10-second synthesis deadline.
- The synthesized clip is checked for audibility before it is hosted or sent. A silent or malformed clip fails closed (`local-tts-failed`, cause `local-tts-silent-audio` or `local-tts-invalid-audio`) because a Cast receiver reports a silent clip as successfully played. Do not pass `amplitude` to `text2wav` (0.0.14): any value produces silent audio; loudness is set by the Cast volume.
- J-arvis serves one random, short-lived WAV URL, bound only to the routed interface. Only the pinned speaker IP may fetch it.
- The pinned Cast device fetches that URL and plays it with the Default Media Receiver.
- The original Cast volume and mute state are restored after playback.

## Configuration

No announcement provider is registered unless at least one exact IPv4 target is pinned.

```text
JARVIS_GOOGLE_HOME_TARGETS_JSON={"Kitchen Display":"192.168.1.20","Bedroom Hub":"192.168.1.21"}
```

Do not commit real household device addresses to Git. Use DHCP reservations/static leases for pinned devices.

Optional TTS voice:

```text
JARVIS_GOOGLE_HOME_TTS_VOICE=en-au
```

The default announcement volume is 0.45. The governed schema accepts 0.05 through 0.8.

## Discovery

Discovery emits no audio:

```bash
npm run home:discover
```

Pin only intended speakers/displays. Avoid Cast groups or TVs unless deliberately required.

## Authority and recovery

- `home:announce` is an external T1 operation.
- The target must be in the pinned map.
- Messages are limited to 200 characters.
- A provider attempt is durably registered before audio is emitted.
- Every Cast callback is bounded and observes cancellation. A failed connection closes the temporary audio listener.
- Cancellation attempts a media STOP only when the LOAD acknowledgment bound the exact audio URL and media-session ID. It never stops an entire receiver application, which may be shared. It then restores volume and closes resources. Cleanup is bounded; a lost connection means physical stopping/restoration is unconfirmed, not guaranteed.
- Success requires audio serving and PLAYING followed by IDLE/FINISHED for the exact media-session ID bound to the approved audio URL. Foreign-session statuses cannot complete the announcement. ERROR, CANCELLED and INTERRUPTED do not count as success.
- Volume restoration failure after playback is reported as an unconfirmed outcome; it must not trigger automatic replay.
- Use a governed execution timeout long enough for speech (30 seconds, the execution boundary maximum); the transport itself has a 60-second lifetime cap.
- Local synthesis does not imply that Cast firmware or the receiver works without internet.
- Speaker playback status is not proof that a person heard the message.
- Announcements are not blindly retried after an indeterminate outcome.
- There is no direct announcement CLI that bypasses governance.
- This bridge has no merge, deployment, shell, or broader smart-home authority.

## Ambiguous receiver setup

If LAUNCH or LOAD has taken effect but its acknowledgment is lost, playback or receiver changes are unconfirmed. Late LAUNCH callbacks cannot start LOAD after cancellation. A shared receiver application is not claimed as exclusively owned or stopped. The existing registered-attempt reconciliation boundary reports an indeterminate outcome; never resend automatically. Existing music or display content may be interrupted by an announcement and is not automatically resumed.

Routing and listener setup observe the execution cancellation signal and have individual two-second timeouts. HTTP listeners are closed on acquisition failure, including cancellation while opening. A bound audio server is not a persistent network service.
