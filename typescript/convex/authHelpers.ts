const OWNER_ID = "jarvis-cli";
const MIN_SERVICE_TOKEN_LENGTH = 32;

/**
 * Constant-time string equality.
 *
 * The Convex query/mutation runtime does not expose `node:crypto` or a
 * synchronous digest, and `requireOwner` is called synchronously from every
 * owner-scoped function, so this cannot use `timingSafeEqual` the way the HTTP
 * guard (`src/http/serviceTokenGuard.ts`) does. Instead it folds every character
 * difference into an accumulator over a fixed number of iterations derived from
 * the configured secret's length — which is not attacker-controlled — and never
 * returns early. A mismatching candidate therefore takes the same time whether
 * it shares a long common prefix with the secret or none at all, so comparison
 * timing does not leak how much of a guessed token was correct.
 */
function constantTimeEquals(candidate: string, secret: string): boolean {
  let diff = candidate.length ^ secret.length;
  for (let i = 0; i < secret.length; i += 1) {
    diff |= secret.charCodeAt(i) ^ (candidate.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function requireOwner(serviceToken: string): string {
  const current = process.env.JARVIS_SERVICE_TOKEN;
  const previous = process.env.JARVIS_SERVICE_TOKEN_PREVIOUS;

  if (!current) {
    throw new Error("Server misconfigured: JARVIS_SERVICE_TOKEN is not set.");
  }
  if (current.length < MIN_SERVICE_TOKEN_LENGTH) {
    throw new Error(
      `Server misconfigured: JARVIS_SERVICE_TOKEN must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters.`,
    );
  }
  if (previous !== undefined && previous.length < MIN_SERVICE_TOKEN_LENGTH) {
    throw new Error(
      `Server misconfigured: JARVIS_SERVICE_TOKEN_PREVIOUS must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters.`,
    );
  }

  const matchesCurrent = serviceToken.length > 0 && constantTimeEquals(serviceToken, current);
  const matchesPrevious =
    previous !== undefined && serviceToken.length > 0 && constantTimeEquals(serviceToken, previous);
  if (!matchesCurrent && !matchesPrevious) {
    // No candidate or configured-token content here — only that a mismatch
    // occurred — so this is safe to leave visible in Convex's function logs
    // for brute-force detection without becoming a secondary leak surface.
    console.warn("Jarvis service token rejected: candidate did not match current or previous.");
    throw new Error("Unauthorized: invalid Jarvis service token.");
  }

  return OWNER_ID;
}
