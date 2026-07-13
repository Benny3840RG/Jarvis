const OWNER_ID = "jarvis-cli";

export function requireOwner(serviceToken: string): string {
  const current = process.env.JARVIS_SERVICE_TOKEN;
  const previous = process.env.JARVIS_SERVICE_TOKEN_PREVIOUS;

  if (!current) {
    throw new Error("Server misconfigured: JARVIS_SERVICE_TOKEN is not set.");
  }

  const matchesCurrent = serviceToken.length > 0 && serviceToken === current;
  const matchesPrevious =
    previous !== undefined && serviceToken.length > 0 && serviceToken === previous;
  if (!matchesCurrent && !matchesPrevious) {
    throw new Error("Unauthorized: invalid Jarvis service token.");
  }

  return OWNER_ID;
}
