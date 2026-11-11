// Live subject check for the owner decision queue (#801): asks GitHub what
// revision a pull request, issue or branch is at now. Read-only. Any failure,
// timeout or unexpected answer is reported as "cannot tell" (null), which the
// service treats as a refusal to approve.

import type { OwnerDecisionSubject } from "./ownerDecision.js";
import type { OwnerDecisionSubjectProbe } from "./ownerDecisionService.js";

export type GitHubSubjectProbeOptions = Readonly<{
  /** owner/name, from the reviewed manifest. */
  repository: string;
  /** Optional read-only token. Needed for a private repository or a higher rate limit. */
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revisionFrom(subject: OwnerDecisionSubject, body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (subject.kind === "issue" || subject.kind === "comment") {
    return typeof body.updated_at === "string" ? body.updated_at : null;
  }
  const holder = subject.kind === "pull-request" ? body.head : body.commit;
  return isRecord(holder) && typeof holder.sha === "string" ? holder.sha : null;
}

export function createGitHubSubjectProbe(
  options: GitHubSubjectProbeOptions,
): OwnerDecisionSubjectProbe {
  const request = options.fetch ?? fetch;
  const base = `https://api.github.com/repos/${options.repository}`;
  return async (subject) => {
    const url =
      subject.kind === "pull-request"
        ? `${base}/pulls/${subject.number}`
        : subject.kind === "issue"
          ? `${base}/issues/${subject.number}`
          : subject.kind === "comment"
            ? `${base}/issues/comments/${subject.id}`
            : `${base}/branches/${encodeURIComponent(subject.name)}`;
    try {
      const response = await request(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "jarvis-owner-decision-queue",
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
      if (!response.ok) return null;
      return revisionFrom(subject, (await response.json()) as unknown);
    } catch {
      return null;
    }
  };
}
