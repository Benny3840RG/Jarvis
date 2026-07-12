const OWNER_ID = "jarvis-cli";

export function requireOwner(serviceToken: string): string {
  const expected = process.env.JARVIS_SERVICE_TOKEN;
  if (!expected) {
    throw new Error("Server misconfigured: JARVIS_SERVICE_TOKEN is not set.");
  }
  if (!serviceToken || serviceToken !== expected) {
    throw new Error("Unauthorized: invalid Jarvis service token.");
  }
  return OWNER_ID;
}
