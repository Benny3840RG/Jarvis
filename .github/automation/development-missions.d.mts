export type DurableCall = (
  kind: "query" | "mutation",
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
export function developmentMissionId(
  repository: string,
  issueNumber: number,
): string;
export function convexDevelopmentClient(env?: NodeJS.ProcessEnv): DurableCall;
export class DevelopmentMissions {
  constructor(call: DurableCall);
  admit(input: {
    repository: string;
    issue: {
      number: number;
      title: string;
      body: string;
      state: string;
      labels: string[];
      html_url: string;
    };
    runId: number;
    sourceSha: string;
    uncertaintyBudget: number;
  }): Promise<{ subjectId: string; workerId: string }>;
  ownerGate(
    subjectId: string,
    observePull: (number: number) => Promise<unknown>,
  ): Promise<unknown>;
  checkpoint(input: {
    subjectId: string;
    workerId: string;
    runId: number;
    pullNumber: number;
    headSha: string;
    success: boolean;
  }): Promise<void>;
  review(input: {
    repository: string;
    issueNumber: number;
    identity: {
      headSha: string;
      baseSha: string;
      pullNumber: number;
      fingerprint: string;
    };
    review: { verdict: string };
    ci: { ok: boolean };
    runUrl: string;
  }): Promise<void>;
}
