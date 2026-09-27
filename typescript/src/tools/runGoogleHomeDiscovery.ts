import { discoverLocalCastDevices } from "../integrations/googleHome/localCastTransport.js";

const timeoutMs = Number.parseInt(
  process.env.JARVIS_GOOGLE_HOME_DISCOVERY_TIMEOUT_MS ?? "5000",
  10,
);
const devices = await discoverLocalCastDevices(Number.isFinite(timeoutMs) ? timeoutMs : 5000);

if (devices.length === 0) {
  console.error(
    "No Google Cast/Home devices discovered. Confirm J-arvis and the speakers are on the same LAN and multicast/mDNS is available.",
  );
  process.exitCode = 2;
} else {
  for (const device of devices) {
    const model = device.model ? `\t${device.model}` : "";
    console.log(`${device.name}\t${device.address}:${device.port}${model}`);
  }
}
