import googleHomeNotifier from "google-home-notifier";

const timeoutMs = Number.parseInt(
  process.env.JARVIS_GOOGLE_HOME_DISCOVERY_TIMEOUT_MS ?? "4000",
  10,
);
const devices = await googleHomeNotifier.getDevices(Number.isFinite(timeoutMs) ? timeoutMs : 4000);

if (devices.length === 0) {
  console.error(
    "No Google Cast/Home devices discovered. Confirm J-arvis and the speakers are on the same LAN and multicast/mDNS is available.",
  );
  process.exitCode = 2;
} else {
  for (const device of devices) {
    console.log(`${device.name}\t${device.address}:${device.port}`);
  }
}
