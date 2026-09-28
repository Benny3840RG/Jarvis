/**
 * Fail-closed audibility check for the synthesized announcement.
 *
 * The Cast receiver reports a silent clip as successfully played, so nothing
 * downstream can tell that a "successful" announcement carried no sound. The
 * check therefore runs before the audio is hosted or sent: a silent or
 * malformed clip must never reach the speaker or be recorded as a success.
 */

export type WavAssessment = Readonly<{
  status: "audible" | "silent" | "invalid";
  /** Largest absolute sample as a fraction of full scale (0 to 1). */
  peak: number;
  durationSeconds: number;
}>;

/** About -26 dBFS: quieter than any real speech from the synthesizer. */
const MIN_PEAK = 0.05;
/** A sample counts as signal above about -46 dBFS. */
const SIGNAL_LEVEL = 0.005;
/** At least this fraction of samples must carry signal. */
const MIN_SIGNAL_FRACTION = 0.01;

const INVALID: WavAssessment = { status: "invalid", peak: 0, durationSeconds: 0 };

/** Assesses 16-bit PCM WAV audio. Anything it cannot fully parse is `invalid`, never `audible`. */
export function assessWav(bytes: Uint8Array): WavAssessment {
  if (bytes.byteLength < 44) return INVALID;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return INVALID;

  let channels = 0;
  let sampleRate = 0;
  let dataStart = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) return INVALID;
      const format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || bits !== 16 || channels < 1 || sampleRate < 1) return INVALID;
    } else if (id === "data") {
      dataStart = body;
      if (body + size > bytes.byteLength) return INVALID;
      dataLength = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (channels === 0 || dataStart < 0) return INVALID;

  const bytesPerFrame = channels * 2;
  if (dataLength === 0 || dataLength % bytesPerFrame !== 0) return INVALID;
  const sampleCount = dataLength / 2;
  let peak = 0;
  let signal = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const level = Math.abs(view.getInt16(dataStart + index * 2, true)) / 32768;
    if (level > peak) peak = level;
    if (level >= SIGNAL_LEVEL) signal += 1;
  }
  const durationSeconds = sampleCount / channels / sampleRate;
  const audible = peak >= MIN_PEAK && signal / sampleCount >= MIN_SIGNAL_FRACTION;
  return { status: audible ? "audible" : "silent", peak, durationSeconds };
}

/** Throws a fixed, non-secret error code unless the clip is audible speech-level audio. */
export function assertAudibleWav(bytes: Uint8Array): void {
  const { status } = assessWav(bytes);
  if (status === "silent") throw new Error("local-tts-silent-audio");
  if (status === "invalid") throw new Error("local-tts-invalid-audio");
}
