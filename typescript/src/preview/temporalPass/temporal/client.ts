import { Client, Connection } from "@temporalio/client";

import { resolveTemporalEnvironment } from "./environment.js";

export interface TemporalClientOptions {
  address?: string;
  namespace?: string;
}

/**
 * Two-step connect (Connection, then Client) — `new Client({address})`
 * directly is not a real constructor shape in this SDK version.
 */
export async function createTemporalClient(options: TemporalClientOptions = {}): Promise<Client> {
  const environment = resolveTemporalEnvironment(process.env);
  const address = options.address ?? environment.address;
  const namespace = options.namespace ?? environment.namespace;
  const connection = await Connection.connect({ address });
  return new Client({ connection, namespace });
}
