import { Connection } from "@temporalio/client";

export type TemporalEnvironmentSource = "default" | "environment";
export type TemporalReadinessStage = "absent" | "configured" | "reachable";

export type TemporalEnvironmentConfig = Readonly<{
  address: string;
  namespace: string;
  configured: boolean;
  required: boolean;
  addressSource: TemporalEnvironmentSource;
  namespaceSource: TemporalEnvironmentSource;
}>;

export type TemporalReadiness = Readonly<{
  stage: TemporalReadinessStage;
  configured: boolean;
  present: boolean;
  reachable: boolean;
  commissioned: false;
  addressSource: TemporalEnvironmentSource;
  namespaceSource: TemporalEnvironmentSource;
  reason: string;
}>;

export type TemporalReadinessConnection = Readonly<{
  close(): Promise<void> | void;
}>;

export type TemporalReadinessConnector = (address: string) => Promise<TemporalReadinessConnection>;

export class TemporalEnvironmentError extends Error {
  override name = "TemporalEnvironmentError";
}

function configuredText(
  env: NodeJS.ProcessEnv,
  name: "TEMPORAL_ADDRESS" | "TEMPORAL_NAMESPACE",
): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) throw new TemporalEnvironmentError(`${name} must not be blank when configured.`);
  return value;
}

function requiredTemporalEnvironment(env: NodeJS.ProcessEnv): boolean {
  const raw = env.JARVIS_TEMPORAL_REQUIRED;
  if (raw === undefined) return false;

  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;

  throw new TemporalEnvironmentError(
    "JARVIS_TEMPORAL_REQUIRED must be one of 1/0, true/false, yes/no, or on/off.",
  );
}

/**
 * Resolve the Temporal connection settings shared by Jarvis clients and workers.
 *
 * Local defaults remain available for the existing preview/test path, but they
 * are deliberately not treated as proof that a Temporal environment was
 * configured by the operator.
 */
export function resolveTemporalEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): TemporalEnvironmentConfig {
  const configuredAddress = configuredText(env, "TEMPORAL_ADDRESS");
  const configuredNamespace = configuredText(env, "TEMPORAL_NAMESPACE");

  return Object.freeze({
    address: configuredAddress ?? "localhost:7233",
    namespace: configuredNamespace ?? "default",
    configured: configuredAddress !== undefined || configuredNamespace !== undefined,
    required: requiredTemporalEnvironment(env),
    addressSource: configuredAddress === undefined ? "default" : "environment",
    namespaceSource: configuredNamespace === undefined ? "default" : "environment",
  });
}

async function connectTemporal(address: string): Promise<TemporalReadinessConnection> {
  return Connection.connect({ address });
}

/**
 * Read-only Temporal readiness probe.
 *
 * This proves only that a client connection can be established. It does not
 * start a Workflow, mutate Temporal state, prove the configured Namespace, or
 * promote the integration to commissioned. Commissioning remains a separate,
 * evidence-backed lifecycle stage.
 */
export async function probeTemporalEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  connect: TemporalReadinessConnector = connectTemporal,
): Promise<TemporalReadiness> {
  const config = resolveTemporalEnvironment(env);

  let connection: TemporalReadinessConnection;
  try {
    connection = await connect(config.address);
  } catch {
    if (config.required) {
      throw new TemporalEnvironmentError(
        "Temporal is required but a client connection could not be established.",
      );
    }

    const present = config.configured;
    return Object.freeze({
      stage: present ? "configured" : "absent",
      configured: config.configured,
      present,
      reachable: false,
      commissioned: false,
      addressSource: config.addressSource,
      namespaceSource: config.namespaceSource,
      reason: present
        ? "Temporal is configured but a client connection could not be established."
        : "No explicit Temporal environment is configured and the local default is not reachable.",
    });
  }

  try {
    await connection.close();
  } catch {
    // Closing the ephemeral probe connection does not change the fact that the
    // Temporal endpoint accepted the connection. Do not leak transport details.
  }

  return Object.freeze({
    stage: "reachable",
    configured: config.configured,
    present: true,
    reachable: true,
    commissioned: false,
    addressSource: config.addressSource,
    namespaceSource: config.namespaceSource,
    reason: "Temporal accepted a client connection; commissioning evidence is not claimed.",
  });
}
