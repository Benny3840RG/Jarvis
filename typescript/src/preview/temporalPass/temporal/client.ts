import { Client, Connection } from "@temporalio/client";

export interface TemporalClientOptions {
  address?: string;
  namespace?: string;
}

/**
 * Two-step connect (Connection, then Client) — `new Client({address})`
 * directly is not a real constructor shape in this SDK version.
 */
export async function createTemporalClient(options: TemporalClientOptions = {}): Promise<Client> {
  const address = options.address ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? "default";
  const connection = await Connection.connect({ address });
  return new Client({ connection, namespace });
}
