import { AsyncLocalStorage } from "node:async_hooks";

const requestSignals = new AsyncLocalStorage<AbortSignal>();

/** The MCP HTTP request currently handling this async call, if any. */
export function currentMcpRequestSignal(): AbortSignal | undefined {
  return requestSignals.getStore();
}

export function runWithMcpRequestSignal<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  return requestSignals.run(signal, work);
}
