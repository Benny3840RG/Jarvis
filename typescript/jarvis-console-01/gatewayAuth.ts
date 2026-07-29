import { createHash, timingSafeEqual } from "node:crypto";

export type GatewayAccessDecision =
  | "allow-initialize"
  | "allow-token"
  | "missing-configuration"
  | "unauthorized";

export type GatewayAccessInput = {
  configuredToken?: string;
  candidateToken?: string;
  rpcMethod?: string;
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function matchesToken(candidate: string, configured: string): boolean {
  return timingSafeEqual(digest(candidate), digest(configured));
}

export function decideGatewayAccess({
  configuredToken,
  candidateToken,
  rpcMethod,
}: GatewayAccessInput): GatewayAccessDecision {
  if (rpcMethod === "initialize") return "allow-initialize";
  if (!configuredToken) return "missing-configuration";
  if (candidateToken === undefined || !matchesToken(candidateToken, configuredToken)) {
    return "unauthorized";
  }
  return "allow-token";
}
