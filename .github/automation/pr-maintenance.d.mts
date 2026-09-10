export function collectCandidateChecks(input: {
  github: unknown;
  owner: string;
  repo: string;
  headSha: string;
  pullNumber?: number;
}): Promise<{
  fingerprint: string;
  ci: { ok: boolean; pending: string[]; problems: string[] };
}>;
