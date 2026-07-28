const MAX_CHANGED_FILES = 30;
const MAX_DIFF_LINES = 2_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

const FORBIDDEN_PATHS = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /^\.github\/automation\//,
  /^\.gitattributes$/,
  /^\.gitmodules$/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)package(?:-lock)?\.json$/,
  /^typescript\/convex\/schema\.ts$/,
  /(^|\/)convex\.json$/,
  /^typescript\/(?:src|convex)\/.*(?:auth|security|permission|approval|authority|policy|credential|secret|token)/i,
  /^typescript\/(?:src|convex)\/.*(?:integration|adapter|provider|reconciliation|external)/i,
  /^typescript\/(?:src|convex)\/.*(?:deploy|commission|billing|payment)/i,
  /^typescript\/src\/actions\//,
  /^typescript\/src\/integrations\//,
  /^typescript\/src\/tools\//,
  /^typescript\/src\/orchestration\//,
  /^typescript\/src\/reconciliation\//,
  /^typescript\/src\/totality\//,
  /^typescript\/src\/http\/(?:app|jarvisHttpModule)\.ts$/,
  /^typescript\/src\/http\/(?:config|serviceTokenGuard|toolAction|totalityRequest)/,
  /^typescript\/src\/mcp\/config\.ts$/,
  /^typescript\/src\/runtime\/(?:totalityContracts|totalityPolicy|validation)\.ts$/,
  /^typescript\/src\/persistence\/convexTool(?:Actions|ExecutionReceipts)\.ts$/,
  /^typescript\/src\/persistence\/convex(?:ExternalReconciliations|QuoteDeliveries)\.ts$/,
  /^typescript\/convex\/(?:authHelpers|toolActionLogic)\.ts$/,
  /^docs\/governance\//,
  /^docs\/registries\//,
  /^docs\/validators\//,
  /^docs\/traceability\/action-family-registry\.yaml$/,
  /^docs\/deployment\.md$/,
];

const SOURCE_PATH =
  /^(?:typescript\/src\/|typescript\/convex\/|typescript\/jarvis-console-01\/src\/).+\.ts$/;
const TEST_PATH =
  /^(?:typescript\/tests\/.*\.test\.ts|typescript\/convex\/.*\.test\.ts|typescript\/jarvis-console-01\/tests\/.*\.test\.ts)$/;

function result(reasons) {
  return { ok: reasons.length === 0, reasons };
}

function labelsOf(issue) {
  return new Set(
    (issue.labels ?? []).map((label) =>
      typeof label === "string" ? label : String(label?.name ?? ""),
    ),
  );
}

export function evaluateIssue(issue) {
  const reasons = [];
  const labels = labelsOf(issue);
  const body = String(issue.body ?? "");
  const hasAcceptanceHeading = /^#{1,6}\s+acceptance criteria\s*$/im.test(body);
  const hasChecklistItem = /^\s*-\s*\[[ xX]\]\s+\S+/m.test(body);

  if (issue.state !== "open") reasons.push("issue is not open");
  if (!labels.has("automation-approved")) reasons.push("automation-approved label is missing");
  if (labels.has("automation-in-progress")) {
    reasons.push("automation-in-progress lock is already present");
  }
  if (issue.hasExistingAutomationPr) reasons.push("automation pull request already exists");
  if (!hasAcceptanceHeading || !hasChecklistItem) {
    reasons.push("testable acceptance criteria are missing");
  }

  return result(reasons);
}

function forbiddenPathReason(path) {
  return FORBIDDEN_PATHS.some((pattern) => pattern.test(path))
    ? `forbidden path changed: ${path}`
    : null;
}

export function evaluateDiff({ files = [] } = {}) {
  const reasons = [];

  if (files.length === 0) reasons.push("no repository changes were produced");
  if (files.length > MAX_CHANGED_FILES) reasons.push("changed file limit exceeded");

  const changedLines = files.reduce(
    (total, file) => total + Number(file.additions ?? 0) + Number(file.deletions ?? 0),
    0,
  );
  if (changedLines > MAX_DIFF_LINES) reasons.push("diff line limit exceeded");
  const totalBytes = files.reduce((total, file) => total + Number(file.bytes ?? 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) reasons.push("total changed byte limit exceeded");

  for (const file of files) {
    const path = String(file.path ?? "");
    const pathReason = forbiddenPathReason(path);
    if (pathReason) reasons.push(pathReason);
    if (file.binary) reasons.push(`binary change is forbidden: ${path}`);
    if (file.symlink) reasons.push(`symlink change is forbidden: ${path}`);
    if (Number(file.bytes ?? 0) > MAX_FILE_BYTES) {
      reasons.push(`changed file byte limit exceeded: ${path}`);
    }
  }

  const sourceAreas = new Set(
    files
      .map((file) => String(file.path ?? ""))
      .filter((path) => SOURCE_PATH.test(path) && !TEST_PATH.test(path))
      .map((path) =>
        path.startsWith("typescript/convex/")
          ? "convex"
          : path.startsWith("typescript/jarvis-console-01/")
            ? "console"
            : "node",
      ),
  );
  const testAreas = new Set(
    files
      .map((file) => String(file.path ?? ""))
      .filter((path) => TEST_PATH.test(path))
      .map((path) =>
        path.startsWith("typescript/convex/")
          ? "convex"
          : path.startsWith("typescript/jarvis-console-01/")
            ? "console"
            : "node",
      ),
  );
  for (const area of sourceAreas) {
    if (!testAreas.has(area)) {
      reasons.push(`source changes require a matching ${area} test change`);
    }
  }

  return result([...new Set(reasons)]);
}

export function evaluateIndexFlags(entries = []) {
  const reasons = [];
  for (const entry of entries) {
    const tag = String(entry?.tag ?? "");
    const path = String(entry?.path ?? "");
    if (tag === "S" || /^[a-z]$/.test(tag)) {
      reasons.push(`forbidden git index flag on ${path || "(unknown path)"}`);
    }
  }
  return result(reasons);
}

export function evaluatePatch(patch) {
  const sensitive =
    /\b(?:authorization|authentication|credential|secret|permission|approval|authority|deploy(?:ment)?|commission(?:ing)?|billing|payment)\b|(?:api|service)[_-]?token|requireApproval|maximumToolAuthority/i;
  const reasons = [];
  const lines = String(patch ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^[+-]/.test(line) || /^(?:\+\+\+|---)/.test(line)) continue;
    if (sensitive.test(line.slice(1))) {
      reasons.push(`authority-sensitive patch content at diff line ${index + 1}`);
    }
  }
  return result(reasons);
}

export function redactReceipt(value) {
  return String(value ?? "")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"',]+/gi, "$1[REDACTED]")
    .replace(
      /((?:OPENAI_API_KEY|JARVIS_SERVICE_TOKEN|CONVEX_DEPLOY_KEY)\s*[:=]\s*)[^\s"',]+/gi,
      "$1[REDACTED]",
    );
}

function requirePatterns(text, requirements) {
  const reasons = [];
  for (const [description, pattern] of requirements) {
    if (!pattern.test(text)) reasons.push(description);
  }
  return result(reasons);
}

export function validatePromptContract(prompt) {
  return requirePatterns(String(prompt ?? ""), [
    ["prompt must classify issue content as untrusted", /issue content.*untrusted/i],
    ["prompt must limit work to one approved issue", /one approved issue only/i],
    ["prompt must forbid workflow changes", /do not change[\s\S]*workflows/i],
    ["prompt must forbid secret changes", /do not change[\s\S]*secrets/i],
    ["prompt must forbid permission changes", /do not change[\s\S]*permissions/i],
    ["prompt must forbid dependency changes", /do not change[\s\S]*dependencies/i],
    ["prompt must forbid schema changes", /do not change[\s\S]*schema/i],
    ["prompt must forbid commissioning", /do not change[\s\S]*commissioning/i],
    ["prompt must forbid merging", /do not change[\s\S]*merging/i],
    ["prompt must forbid deployment", /do not change[\s\S]*deployment/i],
    ["prompt must require tests first", /tests before implementation/i],
    ["prompt must require the Jarvis checks", /npm run check/i],
    ["prompt must cover the console build", /build Jarvis Console/i],
    ["prompt must stop on ambiguity or scope expansion", /stop.*ambiguous.*broader scope/i],
    ["prompt must forbid git publication", /do not commit, push, create pull requests/i],
    ["prompt must forbid external actions", /external actions/i],
  ]);
}

export function validateWorkflowContract(workflow) {
  const text = String(workflow ?? "");
  const requirements = [
    ["workflow must trigger on labelled issues", /issues:[\s\S]*types:\s*\[labeled\]/i],
    ["workflow must support manual dispatch", /workflow_dispatch:/i],
    ["workflow must require automation-approved", /automation-approved/i],
    ["workflow must define concurrency", /concurrency:/i],
    ["workflow must not cancel an in-progress build", /cancel-in-progress:\s*false/i],
    ["workflow must have a finite timeout", /timeout-minutes:\s*[1-9]\d*/i],
    ["workflow must declare permissions", /permissions:/i],
    ["workflow must allow branch writes", /contents:\s*write/i],
    ["workflow must allow issue receipts", /issues:\s*write/i],
    ["workflow must allow draft PR creation", /pull-requests:\s*write/i],
    [
      "Codex action must be pinned to an immutable SHA",
      /openai\/codex-action@[0-9a-f]{40}\b/i,
    ],
    [
      "OpenAI key must come from Actions secrets",
      /openai-api-key:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/i,
    ],
    ["Codex must use workspace permissions", /permission-profile:\s*[\"']?:workspace[\"']?/i],
    ["Codex must drop sudo", /safety-strategy:\s*drop-sudo/i],
    ["workflow must create a draft PR", /(?:draft:\s*true|--draft\b)/i],
    ["workflow must always clean up", /if:\s*always\(\)/i],
    ["guard must verify the original HEAD", /\/opt\/jarvis-autobuild\/base\.sha/i],
    ["guard must include staged changes", /diff[\s\S]*HEAD/i],
    ["guard must parse hostile filenames safely", /--porcelain=v1[\s\S]*-z/i],
    ["publication must disable git hooks", /core\.hooksPath=\/dev\/null/i],
    ["guard must use an immutable validator", /\/opt\/jarvis-autobuild\/validate-autobuild\.mjs/i],
    ["guard must reject hidden index entries", /evaluateIndexFlags/i],
    ["workflow must run clean candidate verification", /^\s{2}verify-candidate:\s*$/m],
    ["workflow must publish candidate commit statuses", /createCommitStatus/i],
    [
      "verification status must use its own namespace",
      /jarvis-autobuild\/verify-candidate/i,
    ],
    [
      "cleanup must track lock ownership",
      /LOCK_ACQUIRED:\s*\$\{\{\s*needs\.build\.outputs\.lock-acquired\s*\}\}/i,
    ],
    [
      "finalize must require the approved trigger",
      /finalize:[\s\S]*if:[\s\S]{0,160}always\(\)[\s\S]{0,240}automation-approved/i,
    ],
    ["automation branches must be attempt-specific", /run-\$\{\{\s*github\.run_id\s*\}\}/i],
  ];

  const checked = requirePatterns(text, requirements);
  const reasons = [...checked.reasons];
  if (/\b(?:merge|deploy|commission)\b.*(?:--|run|create|execute)/i.test(text)) {
    reasons.push("workflow contains a prohibited merge, deploy, or commission command");
  }
  if (/^\s*environment:\s*/m.test(text)) reasons.push("workflow must not target an environment");
  for (const reserved of [
    "automation-policy",
    "typecheck-lint-format-test",
    "jarvis-console-01-build",
    "copilot-review-section",
  ]) {
    const statusContext = new RegExp(
      `createCommitStatus[\\s\\S]{0,1200}[\"']${reserved}[\"']`,
      "i",
    );
    if (statusContext.test(text)) {
      reasons.push(`workflow must not impersonate the ${reserved} check`);
    }
  }

  return result([...new Set(reasons)]);
}

export function validateCiContract(workflow) {
  const text = String(workflow ?? "");
  const checked = requirePatterns(text, [
    [
      "CI must trigger for the autonomous builder workflow",
      /\.github\/workflows\/jarvis-autobuild\.yml/i,
    ],
    [
      "CI must trigger for automation policy changes",
      /\.github\/automation\/\*\*/i,
    ],
    ["CI must define the automation-policy job", /^\s{2}automation-policy:\s*$/m],
    [
      "CI must run the automation policy tests",
      /node --test \.github\/automation\/validate-autobuild\.test\.mjs/i,
    ],
    ["automation-policy must use Node.js 24", /node-version:\s*[\"']?24[\"']?/i],
  ]);
  const reasons = [...checked.reasons];
  const pullRequestSection = text.match(
    /^\s{2}pull_request:\s*$([\s\S]*?)(?=^\S|^\s{2}[a-zA-Z_-]+:\s*$)/m,
  )?.[1];
  if (pullRequestSection && /^\s{4}paths:/m.test(pullRequestSection)) {
    reasons.push("pull-request CI must not use path filters");
  }
  return result(reasons);
}
