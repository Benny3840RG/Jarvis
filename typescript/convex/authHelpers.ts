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

type RuntimeTokenName = "JARVIS_APPROVAL_TOKEN" | "JARVIS_DELIVERY_RUNTIME_TOKEN";
type RuntimePreviousTokenName =
  "JARVIS_APPROVAL_TOKEN_PREVIOUS" | "JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS";

function peerRuntimeTokenNames(currentName: RuntimeTokenName): {
  current: RuntimeTokenName;
  previous: RuntimePreviousTokenName;
} {
  return currentName === "JARVIS_APPROVAL_TOKEN"
    ? {
        current: "JARVIS_DELIVERY_RUNTIME_TOKEN",
        previous: "JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS",
      }
    : {
        current: "JARVIS_APPROVAL_TOKEN",
        previous: "JARVIS_APPROVAL_TOKEN_PREVIOUS",
      };
}

function requireIndependentRuntimeToken(
  candidate: string,
  currentName: RuntimeTokenName,
  previousName: RuntimePreviousTokenName,
  label: string,
): void {
  const current = process.env[currentName];
  const previous = process.env[previousName];
  const peerNames = peerRuntimeTokenNames(currentName);
  const forbiddenCredentials = [
    process.env.JARVIS_SERVICE_TOKEN,
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS,
    process.env[peerNames.current],
    process.env[peerNames.previous],
  ].filter((value): value is string => value !== undefined);

  if (!current) throw new Error(`Server misconfigured: ${currentName} is not set.`);
  if (current.length < MIN_SERVICE_TOKEN_LENGTH) {
    throw new Error(
      `Server misconfigured: ${currentName} must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters.`,
    );
  }
  if (previous !== undefined && previous.length < MIN_SERVICE_TOKEN_LENGTH) {
    throw new Error(
      `Server misconfigured: ${previousName} must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters.`,
    );
  }

  const ownCredentials = previous === undefined ? [current] : [current, previous];
  if (
    ownCredentials.some((credential) =>
      forbiddenCredentials.some((forbidden) => credential === forbidden),
    )
  ) {
    throw new Error(
      `${currentName} and ${previousName} must be distinct from service and peer runtime credentials.`,
    );
  }

  const matchesCurrent = candidate.length > 0 && constantTimeEquals(candidate, current);
  const matchesPrevious =
    previous !== undefined && candidate.length > 0 && constantTimeEquals(candidate, previous);
  if (!matchesCurrent && !matchesPrevious) {
    throw new Error(`Unauthorized: invalid ${label}.`);
  }
}

/** Proves the operator made an approval or revocation decision. */
export function requireApprovalToken(approvalToken: string): void {
  requireIndependentRuntimeToken(
    approvalToken,
    "JARVIS_APPROVAL_TOKEN",
    "JARVIS_APPROVAL_TOKEN_PREVIOUS",
    "approval token",
  );
}

/** Restricts quote-delivery ledger mutations to the trusted delivery runtime. */
export function requireDeliveryRuntimeToken(deliveryRuntimeToken: string): void {
  requireIndependentRuntimeToken(
    deliveryRuntimeToken,
    "JARVIS_DELIVERY_RUNTIME_TOKEN",
    "JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS",
    "delivery runtime token",
  );
}

/**
 * Upper bound on how many documents an owner-scoped "list everything" query may
 * return in a single call. Jarvis is single-user, so real domains sit far below
 * this; the cap exists purely as a guard rail so an unbounded `.collect()` can
 * never grow into a query-limit failure or an ever-more-expensive dashboard
 * read. Callers that legitimately need more should page (see the `listPage`
 * queries) rather than raise this number.
 */
export const MAX_OWNER_LIST_RESULTS = 1000;

/**
 * Runs a bounded read in place of an unbounded `.collect()`. Takes one more than
 * the cap so an overflow is detectable, then fails closed with an explicit error
 * rather than silently truncating the result — matching the fail-closed
 * convention used elsewhere (e.g. development cleanup). `label` names the domain
 * for the error message.
 */
export async function collectBounded<T>(
  query: { take(count: number): Promise<T[]> },
  label: string,
): Promise<T[]> {
  const rows = await query.take(MAX_OWNER_LIST_RESULTS + 1);
  if (rows.length > MAX_OWNER_LIST_RESULTS) {
    throw new Error(
      `${label} list exceeds the bounded read limit of ${MAX_OWNER_LIST_RESULTS} records.`,
    );
  }
  return rows;
}
