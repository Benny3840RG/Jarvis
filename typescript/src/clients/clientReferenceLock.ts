import { JarvisProblem } from "../http/problemDetails.js";

import type { ClientStore } from "./client.js";

let tail: Promise<void> = Promise.resolve();

export type ReferencedClient = {
  clients: Pick<ClientStore, "get">;
  clientId: string;
};

function missingClient(): JarvisProblem {
  return new JarvisProblem(
    404,
    "client-not-found",
    "Client Not Found",
    "The requested client does not exist.",
  );
}

/** Confirm the client still exists. Call this on the lock turn, before the write. */
export async function confirmReferencedClient(
  clients: Pick<ClientStore, "get">,
  clientId: string,
): Promise<void> {
  const client = await clients.get(clientId);
  if (!client) throw missingClient();
}

async function runLocked<T>(
  operation: () => Promise<T>,
  referencedClient: ReferencedClient | undefined,
): Promise<T> {
  if (referencedClient) {
    await confirmReferencedClient(referencedClient.clients, referencedClient.clientId);
  }
  return operation();
}

/**
 * One in-process queue for client deletion and the writes that can add a
 * client reference. The reference scan and the delete stay on the same turn
 * of this queue. A reference-adding write confirms the client still exists
 * before it writes.
 */
export function withClientReferenceLock<T>(
  operation: () => Promise<T>,
  referencedClient?: ReferencedClient,
): Promise<T> {
  const run = tail.then(
    () => runLocked(operation, referencedClient),
    () => runLocked(operation, referencedClient),
  );
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
