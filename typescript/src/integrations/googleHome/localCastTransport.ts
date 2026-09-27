import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import workerThreads from "node:worker_threads";

import Bonjour from "bonjour-service";
import castv2Client from "castv2-client";

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
type CastStatus = Readonly<{
  playerState?: string;
  idleReason?: string;
  mediaSessionId?: number;
  media?: Readonly<{ contentId?: string }>;
}>;
type CastPlayer = {
  media: {
    request(
      data: { type: "STOP"; mediaSessionId: number },
      callback: (error: Error | null) => void,
    ): void;
  };
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

async function routeLocalAddress(remoteAddress: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const socket = dgram.createSocket("udp4");
  try {
    const result = await callbackPromise<string>(
      (done) => {
        socket.once("error", (error) => done(error));
        socket.connect(9, remoteAddress, () => {
          if (signal.aborted) return;
          try {
            const address = socket.address();
            done(null, typeof address === "string" ? address : address.address);
          } catch {
            done(new Error("cast-route-unavailable"));
          }
        });
      },
      signal,
      2_000,
    );
    if (!result) throw new Error("cast-route-unavailable");
    return result;
  } finally {
    socket.close();
  }
}
type HostedAudio = Readonly<{
  url: string;
  served: Promise<void>;
  close(): Promise<void>;
}>;

async function hostAudioForCast(
  audio: Uint8Array,
  remoteAddress: string,
  signal: AbortSignal,
): Promise<HostedAudio> {
  const token = randomUUID();
  const path = `/nolan-announcement-${token}.wav`;
  let resolveServed!: () => void;
  const served = new Promise<void>((resolve) => {
    resolveServed = resolve;
  });

  const server = createServer((request, response) => {
    if (
      request.socket.remoteAddress !== remoteAddress ||
      request.url !== path ||
      (request.method !== "GET" && request.method !== "HEAD")
    ) {
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
    response.once("finish", resolveServed);
    response.end(Buffer.from(audio));
  });

  const serving = new AbortController();
  const servingSignal = AbortSignal.any([signal, serving.signal]);
  try {
    const localAddress = await routeLocalAddress(remoteAddress, servingSignal);
    const port = await listenEphemeral(server, localAddress, servingSignal);
    servingSignal.throwIfAborted();
    return {
      url: `http://${localAddress}:${port}${path}`,
      served,
      async close() {
        serving.abort();
        await closeServer(server);
      },
    };
  } catch (error) {
    serving.abort();
    await closeServer(server);
    throw error;
  }
}

async function listenEphemeral(
  server: Server,
  address: string,
  signal: AbortSignal,
): Promise<number> {
  const port = await callbackPromise<number>(
    (done) => {
      server.on("error", (error) => done(error));
      server.listen({ port: 0, host: address, signal }, () => {
        if (signal.aborted) return;
        const bound = server.address();
        if (!bound || typeof bound === "string") {
          done(new LocalCastTransportError("cast-audio-server-address-unavailable"));
          return;
        }
        done(null, bound.port);
      });
    },
    signal,
    2_000,
  );
  if (port === undefined) throw new Error("cast-audio-server-address-unavailable");
  return port;
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // Abort may already have closed the listener while accepted sockets survive.
    // Always destroy accepted connections, including when listening is false.
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function callbackPromise<T>(
  register: (callback: (error: Error | null, value?: T) => void) => void,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(signal.reason ?? new Error("announcement-aborted"));
    const timer = setTimeout(() => finish(new Error("cast-request-timeout")), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      register((error, value) => finish(error, value));
    } catch (error) {
      finish(error);
    }
  });
}

function observePlayback(player: CastPlayer, signal: AbortSignal, contentUrl: string) {
  let started = false;
  let boundSessionId: number | undefined;
  const pending: CastStatus[] = [];
  let observe: (status: CastStatus) => void = () => undefined;
  const stopped = new AbortController();
  const combined = AbortSignal.any([signal, stopped.signal]);
  const promise = callbackPromise<void>(
    (finish) => {
      observe = (status) => {
        if (!status || typeof status !== "object") {
          finish(new Error("cast-invalid-status"));
          return;
        }
        if (boundSessionId === undefined) {
          if (pending.length >= 32) {
            finish(new Error("cast-status-buffer-full"));
            return;
          }
          pending.push(status);
          return;
        }
        if (status.mediaSessionId !== boundSessionId) return;
        if (status.media?.contentId !== undefined && status.media.contentId !== contentUrl) {
          finish(new Error("cast-content-changed"));
          return;
        }
        if (status.playerState === "PLAYING") started = true;
        if (status.playerState !== "IDLE") return;
        if (!started && status.idleReason === undefined) return;
        if (status.idleReason !== "FINISHED") finish(new Error("cast-playback-not-finished"));
        else if (started) finish(null);
      };
      player.on("status", observe);
    },
    combined,
    45_000,
  );
  void promise.catch(() => undefined);
  return {
    promise,
    bind(status: CastStatus | undefined) {
      if (
        !status ||
        !Number.isSafeInteger(status.mediaSessionId) ||
        (status.mediaSessionId ?? -1) < 0 ||
        status.media?.contentId !== contentUrl
      ) {
        throw new Error("cast-load-identity-unconfirmed");
      }
      boundSessionId = status.mediaSessionId;
      observe(status);
      for (const early of pending.splice(0)) observe(early);
    },
    get mediaSessionId() {
      return boundSessionId;
    },
    dispose() {
      player.removeListener("status", observe);
      pending.length = 0;
      stopped.abort(new Error("cast-playback-observer-closed"));
    },
  };
}

export async function synthesizeAnnouncement(
  message: string,
  voice = "en-au",
  signal: AbortSignal = new AbortController().signal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const worker = new workerThreads.Worker(new URL("./localTtsWorker.mjs", import.meta.url), {
    workerData: { message, voice },
    env: {},
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  // Drain library diagnostics locally; never forward raw library output or text.
  worker.stdout.resume();
  worker.stderr.resume();
  try {
    const audio = await callbackPromise<Uint8Array>(
      (done) => {
        worker.once("message", (value: unknown) => {
          if (
            !(value instanceof Uint8Array) ||
            value.byteLength < 44 ||
            value.byteLength > 4 * 1024 * 1024
          ) {
            done(new Error("local-tts-invalid-audio"));
            return;
          }
          done(null, value);
        });
        worker.once("error", () => done(new Error("local-tts-worker-failed")));
        worker.once("exit", () => done(new Error("local-tts-worker-exited")));
      },
      signal,
      10_000,
    );
    if (!audio) throw new Error("local-tts-no-audio");
    return audio;
  } catch (error) {
    throw new LocalCastTransportError("local-tts-failed", { cause: error });
  } finally {
    await worker.terminate();
    worker.removeAllListeners();
  }
}

export async function castAnnouncement(
  address: string,
  message: string,
  volume: number,
  signal: AbortSignal,
  voice = "en-au",
): Promise<void> {
  signal.throwIfAborted();
  const lifetime = new AbortController();
  const deadline = setTimeout(() => lifetime.abort(new Error("cast-announcement-timeout")), 60_000);
  const activeSignal = AbortSignal.any([signal, lifetime.signal]);
  let hosted: HostedAudio | undefined;
  let client: CastClient | undefined;
  let player: CastPlayer | undefined;
  let playback: ReturnType<typeof observePlayback> | undefined;
  let originalVolume: CastVolume | undefined;
  let succeeded = false;
  let restorationFailed = false;
  try {
    const audio = await synthesizeAnnouncement(message, voice, activeSignal);
    activeSignal.throwIfAborted();
    hosted = await hostAudioForCast(audio, address, activeSignal);
    activeSignal.throwIfAborted();
    const current = new castv2.Client();
    client = current;
    current.on("error", (error) => lifetime.abort(error));
    await callbackPromise<void>((done) => current.connect(address, () => done(null)), activeSignal);
    originalVolume = await callbackPromise<CastVolume>(
      (done) => current.getVolume(done),
      activeSignal,
    );
    if (
      !originalVolume ||
      typeof originalVolume.level !== "number" ||
      !Number.isFinite(originalVolume.level) ||
      typeof originalVolume.muted !== "boolean"
    ) {
      throw new Error("cast-original-volume-unavailable");
    }
    await callbackPromise(
      (done) => current.setVolume({ level: volume, muted: false }, done),
      activeSignal,
    );
    player = await callbackPromise<CastPlayer>(
      (done) => current.launch(castv2.DefaultMediaReceiver, done),
      activeSignal,
    );
    if (!player) throw new Error("cast-player-unavailable");
    const currentPlayer = player;
    const mediaUrl = hosted.url;
    playback = observePlayback(currentPlayer, activeSignal, mediaUrl);
    const status = await callbackPromise<CastStatus>(
      (done) =>
        currentPlayer.load(
          {
            contentId: mediaUrl,
            contentType: "audio/wav",
            streamType: "BUFFERED",
            metadata: { metadataType: 3, title: "NOLAN", artist: "Local announcement" },
          },
          { autoplay: true },
          done,
        ),
      activeSignal,
    );
    playback.bind(status);
    const audioServed = hosted.served;
    await Promise.all([
      callbackPromise<void>(
        (done) => {
          void audioServed.then(() => done(null));
        },
        activeSignal,
        10_000,
      ),
      playback.promise,
    ]);
    activeSignal.throwIfAborted();
    succeeded = true;
  } catch (error) {
    throw new LocalCastTransportError("cast-announcement-failed", { cause: error });
  } finally {
    lifetime.abort(new Error("cast-announcement-ended"));
    clearTimeout(deadline);
    playback?.dispose();
    try {
      if (client) {
        const current = client;
        const cleanupSignal = new AbortController().signal;
        // A LAUNCH can return an existing app. Never STOP that whole app.
        // Stop only a media session positively bound to this announcement URL.
        const mediaSessionId = playback?.mediaSessionId;
        if (!succeeded && player && mediaSessionId !== undefined) {
          const currentPlayer = player;
          await callbackPromise<void>(
            (done) => currentPlayer.media.request({ type: "STOP", mediaSessionId }, done),
            cleanupSignal,
            500,
          ).catch(() => undefined);
        }
        const restore = originalVolume;
        if (restore) {
          try {
            await callbackPromise((done) => current.setVolume(restore, done), cleanupSignal, 500);
          } catch {
            restorationFailed = true;
          }
        }
      }
    } finally {
      try {
        client?.close();
      } finally {
        await hosted?.close();
      }
    }
  }
  if (restorationFailed) {
    throw new LocalCastTransportError("cast-played-volume-restore-unconfirmed");
  }
}
