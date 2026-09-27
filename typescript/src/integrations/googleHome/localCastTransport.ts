import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";

import Bonjour from "bonjour-service";
import castv2Client from "castv2-client";
import text2wav from "text2wav";

const castv2 = castv2Client as {
  Client: new () => CastClient;
  DefaultMediaReceiver: unknown;
};

export type LocalCastDevice = Readonly<{
  name: string;
  address: string;
  port: number;
  model?: string;
}>;

type CastVolume = Readonly<{ level?: number; muted?: boolean }>;
type CastStatus = Readonly<{ playerState?: string; idleReason?: string }>;
type CastPlayer = {
  on(event: "status", listener: (status: CastStatus) => void): void;
  removeListener(event: "status", listener: (status: CastStatus) => void): void;
  load(
    media: Record<string, unknown>,
    options: Readonly<{ autoplay: boolean }>,
    callback: (error: Error | null, status?: CastStatus) => void,
  ): void;
};

type CastClient = {
  connect(host: string, callback: () => void): void;
  close(): void;
  on(event: "error", listener: (error: Error) => void): void;
  removeListener(event: "error", listener: (error: Error) => void): void;
  launch(receiver: unknown, callback: (error: Error | null, player: CastPlayer) => void): void;
  getVolume(callback: (error: Error | null, volume?: CastVolume) => void): void;
  setVolume(
    volume: Readonly<{ level?: number; muted?: boolean }>,
    callback: (error: Error | null, volume?: CastVolume) => void,
  ): void;
};
export class LocalCastTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalCastTransportError";
  }
}

function friendlyName(service: { name: string; txt?: Record<string, unknown> }): string {
  const candidate = service.txt?.fn;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : service.name;
}

export async function discoverLocalCastDevices(
  timeoutMs = 4_000,
): Promise<readonly LocalCastDevice[]> {
  const bonjour = new Bonjour();
  const found = new Map<string, LocalCastDevice>();
  const browser = bonjour.find({ type: "googlecast", protocol: "tcp" });
  browser.on("up", (service) => {
    const address = service.addresses?.find((value) => isIP(value) === 4);
    if (!address) return;
    const name = friendlyName(service);
    const model = typeof service.txt?.md === "string" ? service.txt.md : undefined;
    found.set(`${name}@${address}`, {
      name,
      address,
      port: service.port,
      ...(model ? { model } : {}),
    });
  });

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  browser.stop();
  bonjour.destroy();
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function routeLocalAddress(remoteAddress: string): Promise<string> {
  const socket = dgram.createSocket("udp4");
  try {
    return await new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(9, remoteAddress, () => {
        const address = socket.address();
        resolve(typeof address === "string" ? address : address.address);
      });
    });
  } finally {
    socket.close();
  }
}
type HostedAudio = Readonly<{
  url: string;
  served: Promise<void>;
  close(): Promise<void>;
}>;

async function hostAudioForCast(audio: Uint8Array, remoteAddress: string): Promise<HostedAudio> {
  const token = randomUUID();
  const path = `/nolan-announcement-${token}.wav`;
  let resolveServed!: () => void;
  const served = new Promise<void>((resolve) => {
    resolveServed = resolve;
  });

  const server = createServer((request, response) => {
    if (request.url !== path || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "audio/wav");
    response.setHeader("Content-Length", String(audio.byteLength));
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "HEAD") {
      response.writeHead(200).end();
      return;
    }
    response.writeHead(200);
    response.end(Buffer.from(audio));
    response.once("finish", resolveServed);
  });

  const port = await listenEphemeral(server);
  const localAddress = await routeLocalAddress(remoteAddress);
  return {
    url: `http://${localAddress}:${port}${path}`,
    served,
    close: () => closeServer(server),
  };
}

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new LocalCastTransportError("cast-audio-server-address-unavailable"));
        return;
      }
      resolve(address.port);
    });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function callbackPromise<T>(
  register: (callback: (error: Error | null, value?: T) => void) => void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    register((error, value) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
  });
}

function waitForPlaybackToFinish(
  player: CastPlayer,
  signal: AbortSignal,
  timeoutMs = 45_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let started = false;
    const timeout = setTimeout(() => finish(new Error("cast-playback-timeout")), timeoutMs);
    const onAbort = () => finish(signal.reason ?? new Error("announcement-aborted"));
    const onStatus = (status: CastStatus) => {
      if (status.playerState === "PLAYING" || status.playerState === "BUFFERING") {
        started = true;
      }
      if (started && status.playerState === "IDLE") finish();
    };
    const finish = (error?: unknown) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      player.removeListener("status", onStatus);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    player.on("status", onStatus);
  });
}

async function connectClient(address: string, signal: AbortSignal): Promise<CastClient> {
  const client = new castv2.Client();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    const onAbort = () => {
      client.close();
      reject(signal.reason ?? new Error("announcement-aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    client.on("error", onError);
    client.connect(address, () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
  return client;
}

export async function synthesizeAnnouncement(
  message: string,
  voice = "en-au",
): Promise<Uint8Array> {
  try {
    return await text2wav(message, {
      voice,
      speed: 165,
      amplitude: 110,
      noFinalPause: true,
    });
  } catch (error) {
    throw new LocalCastTransportError("local-tts-failed", { cause: error });
  }
}
export async function castAnnouncement(
  address: string,
  message: string,
  volume: number,
  signal: AbortSignal,
  voice = "en-au",
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("announcement-aborted");
  const audio = await synthesizeAnnouncement(message, voice);
  const hosted = await hostAudioForCast(audio, address);
  const client = await connectClient(address, signal);
  const abortClient = () => client.close();
  signal.addEventListener("abort", abortClient, { once: true });
  let originalVolume: CastVolume | undefined;

  try {
    originalVolume = await callbackPromise<CastVolume>((callback) => client.getVolume(callback));
    await callbackPromise((callback) =>
      client.setVolume({ level: volume, muted: false }, callback),
    );
    const player = await callbackPromise<CastPlayer>((callback) =>
      client.launch(castv2.DefaultMediaReceiver, callback),
    );
    if (!player) throw new LocalCastTransportError("cast-player-unavailable");

    const finished = waitForPlaybackToFinish(player, signal);
    await callbackPromise((callback) =>
      player.load(
        {
          contentId: hosted.url,
          contentType: "audio/wav",
          streamType: "BUFFERED",
          metadata: {
            metadataType: 3,
            title: "NOLAN",
            artist: "Local announcement",
          },
        },
        { autoplay: true },
        callback,
      ),
    );

    await Promise.race([
      hosted.served,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("cast-audio-fetch-timeout")), 10_000),
      ),
    ]);
    await finished;
  } catch (error) {
    throw new LocalCastTransportError("cast-announcement-failed", { cause: error });
  } finally {
    const volumeToRestore = originalVolume;
    if (volumeToRestore) {
      await callbackPromise((callback) =>
        client.setVolume(
          {
            ...(volumeToRestore.level === undefined ? {} : { level: volumeToRestore.level }),
            ...(volumeToRestore.muted === undefined ? {} : { muted: volumeToRestore.muted }),
          },
          callback,
        ),
      ).catch(() => undefined);
    }
    signal.removeEventListener("abort", abortClient);
    client.close();
    await hosted.close();
  }
}
