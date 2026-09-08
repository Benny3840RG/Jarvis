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
  if (!labels.has("automation-approved"))
    reasons.push("automation-approved label is missing");
  if (labels.has("automation-in-progress")) {
    reasons.push("automation-in-progress lock is already present");
  }
  if (issue.hasExistingAutomationPr)
    reasons.push("automation pull request already exists");
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
  if (files.length > MAX_CHANGED_FILES)
    reasons.push("changed file limit exceeded");

  const changedLines = files.reduce(
    (total, file) =>
      total + Number(file.additions ?? 0) + Number(file.deletions ?? 0),
    0,
  );
  if (changedLines > MAX_DIFF_LINES) reasons.push("diff line limit exceeded");
  const totalBytes = files.reduce(
    (total, file) => total + Number(file.bytes ?? 0),
    0,
  );
  if (totalBytes > MAX_TOTAL_BYTES)
    reasons.push("total changed byte limit exceeded");

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
  let oldPath = "";
  let newPath = "";
  let inHunk = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      oldPath = "";
      newPath = "";
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      const candidate = line.slice(4);
      oldPath = candidate.startsWith("a/") ? candidate.slice(2) : "";
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const candidate = line.slice(4);
      newPath = candidate.startsWith("b/") ? candidate.slice(2) : "";
      continue;
    }
    if (!/^[+-]/.test(line)) continue;
    const currentPath = line.startsWith("+") ? newPath : oldPath;
    if (/^docs\/operations\/.+\.md$/.test(currentPath)) continue;
    if (sensitive.test(line.slice(1))) {
      reasons.push(
        `authority-sensitive patch content at diff line ${index + 1}`,
      );
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

function topLevelJobBody(text, jobName) {
  const startPattern = new RegExp(`^  ${jobName}:\\s*$`, "m");
  const match = startPattern.exec(text);
  if (!match) return "";
  const bodyStart = text.indexOf("\n", match.index + match[0].length);
  if (bodyStart < 0) return "";
  const remainder = text.slice(bodyStart + 1);
  const nextJob = /^  [A-Za-z0-9_-]+:\s*$/m.exec(remainder);
  return nextJob ? remainder.slice(0, nextJob.index) : remainder;
}

export function validatePromptContract(prompt) {
  return requirePatterns(String(prompt ?? ""), [
    [
      "prompt must classify issue content as untrusted",
      /issue content.*untrusted/i,
    ],
    [
      "prompt must limit work to one approved issue",
      /one approved issue only/i,
    ],
    ["prompt must forbid workflow changes", /do not change[\s\S]*workflows/i],
    ["prompt must forbid secret changes", /do not change[\s\S]*secrets/i],
    [
      "prompt must forbid permission changes",
      /do not change[\s\S]*permissions/i,
    ],
    [
      "prompt must forbid dependency changes",
      /do not change[\s\S]*dependencies/i,
    ],
    ["prompt must forbid schema changes", /do not change[\s\S]*schema/i],
    ["prompt must forbid commissioning", /do not change[\s\S]*commissioning/i],
    ["prompt must forbid merging", /do not change[\s\S]*merging/i],
    ["prompt must forbid deployment", /do not change[\s\S]*deployment/i],
    ["prompt must require tests first", /tests before implementation/i],
    ["prompt must require the Jarvis checks", /npm run check/i],
    ["prompt must cover the console build", /build Jarvis Console/i],
    [
      "prompt must stop on ambiguity or scope expansion",
      /stop.*ambiguous.*broader scope/i,
    ],
    [
      "prompt must forbid git publication",
      /do not commit, push, create pull requests/i,
    ],
    ["prompt must forbid external actions", /external actions/i],
  ]);
}

export function validateWorkflowContract(workflow) {
  const text = String(workflow ?? "");
  const requirements = [
    ["workflow must support manual dispatch", /workflow_dispatch:/i],
    ["workflow must require automation-approved", /automation-approved/i],
    ["workflow must define concurrency", /concurrency:/i],
    [
      "workflow concurrency must be repository-global for one serial worker",
      /^\s{2}group:\s*jarvis-autobuild-\$\{\{\s*github\.repository\s*\}\}\s*$/im,
    ],
    [
      "workflow must not cancel an in-progress build",
      /cancel-in-progress:\s*false/i,
    ],
    [
      "eligibility must reject a concurrently active mission",
      /another mission is active/i,
    ],
    [
      "eligibility must not silently retry a blocked issue on the coordinated path",
      /automation-blocked[\s\S]{0,80}internalDispatch/i,
    ],
    [
      "builder must accept a verified source revision input",
      /^\s+source_sha:\s*$/m,
    ],
    [
      "builder must verify the dispatched source revision before work",
      /name: Verify the dispatched source revision/i,
    ],
    [
      "builder must load the shared revision-health module",
      /import\([\s\S]{0,120}revision-health\.mjs/i,
    ],
    [
      "builder must evaluate source revision health",
      /evaluateRevisionHealth\(/,
    ],
    [
      "builder must confirm the source revision is on main",
      /sourceRevisionIsOnMain\(|compareCommitsWithBasehead\(/i,
    ],
    [
      "builder must check out the verified source revision",
      /ref:\s*\$\{\{\s*steps\.source\.outputs\.source_sha\s*\}\}/i,
    ],
    [
      "builder must hash the revision-health verifier as an immutable control",
      /sha256sum[\s\S]{0,200}\.github\/automation\/revision-health\.mjs/i,
    ],
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
    [
      "Codex must use the commissioned gpt-5.6-luna model",
      /^\s+model:\s*gpt-5\.6-luna\s*$/im,
    ],
    [
      "Codex must use bounded medium reasoning effort",
      /^\s+effort:\s*medium\s*$/im,
    ],
    [
      "Codex must use workspace permissions",
      /permission-profile:\s*[\"']?:workspace[\"']?/i,
    ],
    ["Codex must drop sudo", /safety-strategy:\s*drop-sudo/i],
    ["workflow must create a draft PR", /(?:draft:\s*true|--draft\b)/i],
    ["workflow must always clean up", /if:\s*always\(\)/i],
    [
      "guard must verify the original HEAD",
      /\/opt\/jarvis-autobuild\/base\.sha/i,
    ],
    ["guard must include staged changes", /diff[\s\S]*HEAD/i],
    ["guard must parse hostile filenames safely", /--porcelain=v1[\s\S]*-z/i],
    ["publication must disable git hooks", /core\.hooksPath=\/dev\/null/i],
    [
      "publication must create missing metadata labels safely",
      /gh label view automation-generated[\s\S]{0,500}gh label create automation-generated/i,
    ],
    [
      "publication metadata labelling must be non-fatal",
      /if ! gh pr edit "\$pr_url" --add-label automation-generated; then[\s\S]{0,300}::warning::[\s\S]{0,120}fi/i,
    ],
    [
      "candidate outputs must precede optional metadata operations",
      /candidate_sha="[\s\S]{0,500}echo "pr_url=\$pr_url" >>"\$GITHUB_OUTPUT"[\s\S]{0,800}if ! gh pr edit "\$pr_url" --add-label automation-generated/i,
    ],
    [
      "guard must use an immutable validator",
      /\/opt\/jarvis-autobuild\/validate-autobuild\.mjs/i,
    ],
    ["guard must reject hidden index entries", /evaluateIndexFlags/i],
    [
      "workflow must define candidate verification",
      /^\s{2}verify-candidate:\s*$/m,
    ],
    ["candidate verification must read check runs", /checks:\s*read/i],
    ["workflow must publish candidate commit statuses", /createCommitStatus/i],
    [
      "verification status must use its own namespace",
      /jarvis-autobuild\/verify-candidate/i,
    ],
    [
      "guard must install a root-owned Node runtime",
      /install -o root -g root -m 0555[\s\\]*"\$trusted_node"[\s\\]*\/opt\/jarvis-autobuild\/node/i,
    ],
    ["guard must verify the immutable Node runtime metadata", /root:root:555/i],
    [
      "cleanup must persist authenticated lock ownership",
      /jarvis-autobuild-lock:[\s\S]*github\.paginate[\s\S]*github-actions\[bot\]/i,
    ],
    [
      "finalize must run only for a manual dispatch",
      /finalize:[\s\S]*?if:[\s\S]{0,120}always\(\)[\s\S]{0,120}github\.event_name == 'workflow_dispatch'/i,
    ],
    [
      "success must keep the mission lock for the draft PR",
      /if \(succeeded\)[\s\S]{0,800}Mission lock held/i,
    ],
    [
      "automation branches must be attempt-specific",
      /run-\$\{\{\s*github\.run_id\s*\}\}/i,
    ],
  ];

  const checked = requirePatterns(text, requirements);
  const reasons = [...checked.reasons];
  if (/^on:[\s\S]*?^\S/m.test(text)) {
    const onBlock = /^on:([\s\S]*?)^\S/m.exec(text)?.[1] ?? "";
    if (/\bissues:/.test(onBlock) || /\bpull_request(?:_target)?:/.test(onBlock)) {
      reasons.push(
        "builder must be dispatch-only; approval routing belongs to jarvis-queue-advance.yml",
      );
    }
  }
  const verifyCandidate = topLevelJobBody(text, "verify-candidate");
  if (verifyCandidate) {
    if (!/github\.rest\.checks\.listForRef/i.test(verifyCandidate)) {
      reasons.push("candidate verification must query check runs for the exact ref");
    }
    if (!/actions:\s*write/i.test(verifyCandidate)) {
      reasons.push("candidate verification must approve held PR workflows");
    }
    if (
      !/github\.rest\.actions\.listWorkflowRunsForRepo/i.test(verifyCandidate)
    ) {
      reasons.push("candidate verification must list candidate workflow runs");
    }
    if (!/github\.rest\.actions\.approveWorkflowRun/i.test(verifyCandidate)) {
      reasons.push(
        "candidate verification must approve held candidate PR runs",
      );
    }
    if (/actions\/checkout@/i.test(verifyCandidate)) {
      reasons.push(
        "candidate verification must not check out candidate content",
      );
    }
    if (/actions\/setup-node@/i.test(verifyCandidate)) {
      reasons.push(
        "candidate verification must not set up a candidate runtime",
      );
    }
    if (/\bnpm(?:\s|$)/im.test(verifyCandidate)) {
      reasons.push(
        "candidate verification must not execute npm from candidate content",
      );
    }
    for (const requiredCheck of [
      "automation-policy",
      "typecheck-lint-format-test",
      "jarvis-console-01-build",
      "pr-evidence",
      "CodeQL",
    ]) {
      if (!verifyCandidate.includes(`"${requiredCheck}"`)) {
        reasons.push(
          `candidate verification must require the ${requiredCheck} check`,
        );
      }
    }
  }
  if (
    /\b(?:merge|deploy|commission)\b.*(?:--|run|create|execute)/i.test(text)
  ) {
    reasons.push(
      "workflow contains a prohibited merge, deploy, or commission command",
    );
  }
  if (/^\s*environment:\s*/m.test(text))
    reasons.push("workflow must not target an environment");
  for (const reserved of [
    "automation-policy",
    "typecheck-lint-format-test",
    "jarvis-console-01-build",
    "pr-evidence",
    "CodeQL",
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
      "CI must define the automation-policy job",
      /^\s{2}automation-policy:\s*$/m,
    ],
    [
      "CI must run the automation policy tests",
      /node --test \.github\/automation\/validate-autobuild\.test\.mjs/i,
    ],
    [
      "CI must run the queue-advance policy tests",
      /\.github\/automation\/jarvis-queue-advance\.test\.mjs/i,
    ],
    [
      "CI must run the revision-health policy tests",
      /\.github\/automation\/revision-health\.test\.mjs/i,
    ],
    [
      "automation-policy must use Node.js 24",
      /node-version:\s*[\"']?24[\"']?/i,
    ],
  ]);
  const reasons = [...checked.reasons];
  // `jarvis-queue-advance.yml`'s `verify-main` waits for this workflow's required
  // checks on the current `main` HEAD before dispatching a mission. Neither
  // trigger may carry a paths filter: a commit on `main` filtered out of this
  // workflow would never produce those checks, and the queue would stall waiting
  // for them. `pull_request` runs unconditionally, so every commit that reaches
  // `main` has already produced them at least once.
  const pushSection = text.match(
    /^\s{2}push:\s*$([\s\S]*?)(?=^\s{2}\S)/m,
  )?.[1];
  if (pushSection && /^\s{4}paths:/m.test(pushSection)) {
    reasons.push(
      "push CI must not use path filters (verify-main needs every main commit to produce the required checks)",
    );
  }
  const pullRequestSection = text.match(
    /^\s{2}pull_request:\s*$([\s\S]*?)(?=^\S|^\s{2}[a-zA-Z_-]+:\s*$)/m,
  )?.[1];
  if (pullRequestSection && /^\s{4}paths:/m.test(pullRequestSection)) {
    reasons.push("pull-request CI must not use path filters");
  }
  return result(reasons);
}

const QUEUE_ADVANCE_DISPATCH_TARGET =
  /workflow_id:\s*["']jarvis-autobuild\.yml["']/i;

export function validateQueueAdvanceContract(workflow) {
  const text = String(workflow ?? "");
  const checked = requirePatterns(text, [
    ["queue advance must route label approvals", /issues:\s*\n\s*types:\s*\[labeled\]/i],
    ["queue advance must react to closed pull requests", /pull_request:\s*\n\s*types:\s*\[closed\]/i],
    ["queue advance must run a recovery sweep", /schedule:\s*\n(?:\s*#.*\n)*\s*-\s*cron:/i],
    ["queue advance must support a manual sweep", /workflow_dispatch:/i],
    ["queue advance must be repository-global", /group:\s*jarvis-queue-advance-\$\{\{\s*github\.repository\s*\}\}/i],
    ["queue advance must not cancel a running advance", /cancel-in-progress:\s*false/i],
    ["queue advance must have a finite timeout", /timeout-minutes:\s*[1-9]\d*/i],
    ["queue advance must verify main before dispatch", /needs:\s*\[?\s*verify-main/i],
    ["queue advance must gate label approvals on the labeler's permission", /getCollaboratorPermissionLevel/],
    ["queue advance must read the labeler from the trusted event payload", /github\.event\.sender\.login/],
    ["queue advance must resolve the current main revision", /rest\.repos\.getBranch/i],
    ["queue advance must verify health via the shared revision-health module", /revision-health\.mjs/i],
    ["queue advance must evaluate revision health", /evaluateRevisionHealth/],
    ["queue advance must dispatch only the bounded builder", QUEUE_ADVANCE_DISPATCH_TARGET],
    ["queue advance must forward the verified revision to the builder", /inputs:\s*\{[^}]*source_sha/i],
    ["queue advance must handle an unmerged candidate close", /merged\s*==\s*false|!\s*.*merged|pull_request\.merged\b/i],
    ["queue advance must reconcile stale mission locks on sweeps", /reconcileLocks/],
    ["queue advance must load the pinned selection module", /select-next-mission\.mjs/i],
  ]);
  const reasons = [...checked.reasons];

  for (const pin of text.match(/uses:\s*\S+/g) ?? []) {
    if (!/@[0-9a-f]{40}\b/.test(pin)) {
      reasons.push(`action is not pinned to an immutable SHA: ${pin.trim()}`);
    }
  }
  if (/contents:\s*write/i.test(text)) {
    reasons.push("queue advance must never hold write access to repository contents");
  }
  if (/pulls\.merge|mergePullRequest|--merge\b|gh pr merge|--squash\b|--rebase\b/i.test(text)) {
    reasons.push("queue advance must never merge a pull request");
  }
  if (/createReview|submitReview|--approve\b|event:\s*["']APPROVE["']/i.test(text)) {
    reasons.push("queue advance must never approve a pull request");
  }
  if (/markReady|ready_for_review|--ready\b|convertPullRequestToDraft/i.test(text)) {
    reasons.push("queue advance must never change pull-request draft state");
  }
  if (/\b(?:deploy|commission)\b/i.test(text)) {
    reasons.push("queue advance must never deploy or commission");
  }
  if (/actions\/checkout@[0-9a-f]{40}[\s\S]{0,200}ref:\s*\$\{\{\s*github\.event\.pull_request\.head/i.test(text)) {
    reasons.push("queue advance must never check out untrusted pull-request head content");
  }
  return result([...new Set(reasons)]);
}
