/**
 * Runtime authority guard for the versioned Temporal PASS worker (roadmap PR B,
 * toward AUTH-INV-04).
 *
 * A production (versioned) worker must never hold an approval credential.
 * Approval is the owner's, granted through the governed execution boundary; a
 * worker that could read the approval token could forge the one human-only step
 * in the merge path (JARVIS-007: authority cannot expand by delegation). This
 * fails the worker closed at startup rather than trusting that a token that is
 * present merely "isn't used".
 *
 * This module only reads the *names* of the approval-credential environment
 * variables to assert they are unset; it never reads a token value. That is why
 * `tests/authorityContract.test.ts` allowlists it alongside the two governed
 * approval-boundary modules: it guards against the token, it does not handle it.
 *
 * Scope: this is one half of AUTH-INV-04's runtime enforcement — "the versioned
 * worker holds no approval credential". The other half — activities reach
 * external effects only through the governed boundary — is a later PR-B slice,
 * so AUTH-INV-04 stays `guarded` in the authority contract for now.
 */

/** Environment variables that carry an owner approval credential (see `src/http/config.ts`). */
export const APPROVAL_CREDENTIAL_ENV_VARS = [
  "JARVIS_APPROVAL_TOKEN",
  "JARVIS_APPROVAL_TOKEN_PREVIOUS",
] as const;

export type WorkerEnv = Readonly<Record<string, string | undefined>>;

export class WorkerAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerAuthorityError";
  }
}

/**
 * Throw `WorkerAuthorityError` if the worker's environment carries any approval
 * credential. A blank or whitespace-only value counts as unset.
 */
export function assertWorkerHoldsNoApprovalCredential(env: WorkerEnv): void {
  const present = APPROVAL_CREDENTIAL_ENV_VARS.filter((name) => (env[name] ?? "").trim() !== "");
  if (present.length > 0) {
    throw new WorkerAuthorityError(
      `A versioned Temporal worker must hold no approval credential, but ${present.join(", ")} ${
        present.length === 1 ? "is" : "are"
      } set. Approval is owner-only and flows through the governed boundary; remove it from the worker's environment.`,
    );
  }
}
