# Governed Google Home / Nest announcements

NOLAN can emit a short spoken announcement to an explicitly pinned Google Cast device on the local LAN.

The capability is registered as the external operation `home:announce`. It does not expose a general Cast remote-control surface and does not bypass the existing ToolAction / ΩΣ claim, receipt, and reconciliation boundary.

## Transport

- mDNS discovery is read-only and uses `_googlecast._tcp`.
- Speech is synthesized locally on J-arvis with `text2wav`.
- J-arvis serves one random, short-lived WAV URL on its LAN IP.
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
- Timeout/abort closes the Cast client.
- Announcements are not blindly retried after an indeterminate outcome.
- There is no direct announcement CLI that bypasses governance.
- This bridge has no merge, deployment, shell, or broader smart-home authority.
