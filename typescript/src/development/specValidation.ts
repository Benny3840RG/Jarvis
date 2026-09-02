import { createHash } from "node:crypto";

import { canonicalJson } from "../actions/canonicalJson.js";

const HASH_ALGORITHM = "sha256";
const SPEC_HASH_VERSION = "development-spec-hash:v1";
const SUBJECT_ID_VERSION = "development-subject-id:v1";

const MIN_BODY_LENGTH = 40;
const MAX_TITLE_LENGTH = 200;

// Matches a markdown checklist item, e.g. "- [ ] Do the thing" or "- [x] Done".
const CHECKLIST_ITEM_PATTERN = /^\s*[-*]\s*\[[ xX]\]\s+(.+)$/;

export interface GithubIssueSnapshot {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly state: "open" | "closed";
  readonly htmlUrl: string;
}

export interface SpecValidationPolicy {
  readonly requiredLabels?: readonly string[];
  readonly minBodyLength?: number;
  readonly maxTitleLength?: number;
}

export interface SourceIssueRef {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly htmlUrl: string;
}

export interface DevelopmentSpecification {
  readonly subjectId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly sourceIssue: SourceIssueRef;
  readonly specHash: string;
}

export type SpecValidationRejectionReason =
  | "ISSUE_NOT_OPEN"
  | "no-acceptance-criteria"
  | "MISSING_REQUIRED_LABEL"
  | "BODY_TOO_SHORT"
  | "TITLE_TOO_LONG";

export type SpecValidationResult =
  | { readonly valid: true; readonly specification: DevelopmentSpecification }
  | { readonly valid: false; readonly reasons: readonly SpecValidationRejectionReason[] };

function digest(prefix: string, value: unknown): string {
  return `${prefix}:${createHash(HASH_ALGORITHM).update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function deriveDevelopmentSubjectId(ref: {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}): string {
  return digest(SUBJECT_ID_VERSION, {
    owner: ref.owner,
    repo: ref.repo,
    issueNumber: ref.issueNumber,
  });
}

export function computeSpecHash(input: {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
}): string {
  return digest(SPEC_HASH_VERSION, {
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
  });
}

function parseAcceptanceCriteria(body: string): readonly string[] {
  return body
    .split("\n")
    .map((line) => line.match(CHECKLIST_ITEM_PATTERN)?.[1]?.trim())
    .filter((item): item is string => Boolean(item));
}

/**
 * Turns a raw GitHub issue snapshot into a validated DevelopmentSpecification,
 * or a list of rejection reasons. Pure and deterministic -- no GitHub API
 * calls here; the snapshot must already have been fetched by the caller.
 *
 * Reuses "no-acceptance-criteria", the exact reason string
 * src/omega/policy.ts#evaluateOmegaCompletion already uses for the identical
 * concept, since these specifications are intended to eventually bridge into
 * omegaMissions.create's acceptanceCriteria -- one vocabulary, not two.
 */
export function validateGithubIssueSpecification(
  issue: GithubIssueSnapshot,
  policy: SpecValidationPolicy,
): SpecValidationResult {
  const reasons: SpecValidationRejectionReason[] = [];

  if (issue.state !== "open") reasons.push("ISSUE_NOT_OPEN");

  const minBodyLength = policy.minBodyLength ?? MIN_BODY_LENGTH;
  if (issue.body.trim().length < minBodyLength) reasons.push("BODY_TOO_SHORT");

  const maxTitleLength = policy.maxTitleLength ?? MAX_TITLE_LENGTH;
  if (issue.title.length > maxTitleLength) reasons.push("TITLE_TOO_LONG");

  const requiredLabels = policy.requiredLabels ?? [];
  const hasAllRequiredLabels = requiredLabels.every((label) => issue.labels.includes(label));
  if (!hasAllRequiredLabels) reasons.push("MISSING_REQUIRED_LABEL");

  const acceptanceCriteria = parseAcceptanceCriteria(issue.body);
  if (acceptanceCriteria.length === 0) reasons.push("no-acceptance-criteria");

  if (reasons.length > 0) return { valid: false, reasons };

  const objective = issue.title.trim();
  const specHash = computeSpecHash({ objective, acceptanceCriteria });

  return {
    valid: true,
    specification: {
      subjectId: deriveDevelopmentSubjectId(issue),
      objective,
      acceptanceCriteria,
      sourceIssue: {
        owner: issue.owner,
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        htmlUrl: issue.htmlUrl,
      },
      specHash,
    },
  };
}
