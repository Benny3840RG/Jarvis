// Adapted from OpenClaw v2026.9.5, commit ec9c1a13db8938e5a3eaa51fca2e981cde2395a9:
// src/infra/http-response-body.ts and src/infra/http-response-body-timeout.ts.
// Stream byte accounting and non-blocking cancellation preserve bounded failure paths.
// See docs/third-party/openclaw/LICENSE for the MIT license and
// docs/third-party/openclaw/THIRD_PARTY_NOTICES.md for incorporated-code notices.
export const DEFAULT_PROVIDER_RESPONSE_MAX_BYTES = 1_048_576;

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Response body read aborted", { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

/** Read provider text under a byte cap, retaining cancellation after response headers. */
export async function readBoundedResponseText(
  response: Response,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_PROVIDER_RESPONSE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const { signal } = options;
  if (signal?.aborted) {
    const error = abortReason(signal);
    void response.body?.cancel(error).catch(() => undefined);
    throw error;
  }

  const overflow = () => new Error(`Provider response exceeds ${maxBytes} bytes`);
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    const error = overflow();
    void response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    : undefined;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const read = async () => {
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortReason(signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) throw overflow();
      if (value.byteLength > 0) chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, totalBytes));
  };
  try {
    // Race once for the operation; per-chunk races would retain abort handlers per read.
    return await (aborted ? Promise.race([read(), aborted]) : read());
  } catch (error) {
    // Teed responses or a broken source may never settle their cancellation promise.
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
