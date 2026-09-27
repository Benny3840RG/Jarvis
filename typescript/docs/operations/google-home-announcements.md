# Google Home / Nest announcements

NOLAN exposes Google Cast speech as a governed external effect. The implementation deliberately does not expose a general Cast remote-control surface.

## Configuration

Set an explicit target-to-IP map on the host:

```bash
JARVIS_GOOGLE_HOME_TARGETS_JSON='{"Kitchen Display":"192.168.4.25"}'
```

Use DHCP reservations/static leases so the configured address cannot silently move to another device.

The target name is part of the approved ToolAction arguments and must exactly match a configured key. Message length is limited to 200 characters, matching the upstream TTS provider's single-request limit. Announcement volume defaults to 0.45 and is capped at 0.80.

Announcement text is sent to Google's Translate TTS service by `google-home-notifier`, so do not use this channel for secrets or sensitive client information.

## Discovery

```bash
npm run home:discover
```

Discovery uses mDNS. If multicast discovery is unavailable, identify the Cast device on the LAN and configure its fixed IP explicitly.

## Authority and recovery

The operation is `home:announce`.

It is registered as an external provider and therefore must pass the existing ToolAction / ΩΣ claim, receipt, and reconciliation boundary. The provider attempt identity is registered before audio emission.

Announcements are not safely repeatable. If execution becomes indeterminate after the provider attempt is registered, do not blindly retry. Reconcile/escalate instead.

No merge, deployment, authority-policy, or general Google account capability is granted by this integration.
