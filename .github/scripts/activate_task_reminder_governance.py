from pathlib import Path
from textwrap import dedent


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def append_entries(path: Path, entries: str) -> None:
    path.write_text(path.read_text(encoding="utf-8").rstrip() + "\n\n" + entries.rstrip() + "\n", encoding="utf-8")


action_path = Path("docs/traceability/action-family-registry.yaml")
action_text = action_path.read_text(encoding="utf-8")

internal_overlay = dedent(
    """\
      internal_mutation:
        effect_class: mutate
        approval:
          mode: never
        external_side_effects:
          mode: false
        reconciliation:
          required: false
        offline_support: true
        retention_default: standard
    """
)
destructive_overlay = internal_overlay + dedent(
    """\

      destructive_internal_mutation:
        effect_class: destructive
        approval:
          mode: always
          binding: exact_action_fingerprint
        external_side_effects:
          mode: false
        reconciliation:
          required: false
        offline_support: true
        retention_default: long_term
    """
)
if action_text.count(internal_overlay) != 1:
    raise SystemExit("internal_mutation overlay was not found exactly once")
action_text = action_text.replace(internal_overlay, destructive_overlay, 1)

marker = "  - id: AM-012\n"
if action_text.count(marker) != 1:
    raise SystemExit("AM-012 insertion marker was not found exactly once")

families = dedent(
    """\
      - id: AM-004
        name: Create task
        lifecycle_status: active
        owner: tasks_domain
        version: 1
        classification:
          verb: create
          object: task
          domains: [business, home, workshop, shared]
          capability: tasks
        policy_overlay: internal_mutation
        sensitivity:
          mode: fixed
          value: private
        execution:
          external_side_effects:
            mode: false
          offline_support: true
        idempotency:
          enabled: true
          key_strategy: normalized_payload_hash
          scope: owner_project_action_family
          replay_policy: return_original_result
          collision_policy: reject_and_log
        bindings:
          executor_id: TOOL-TASKS-CREATE
          state_target_id: STORE-TASKS
          tool_contract_version: "1"
        state_impact:
          entity: task
          transition: create
        reconciliation:
          required: false
        traceability:
          requirements:
            primary: [R-001, R-028, R-073]
            supporting: [R-039, R-040, R-041, R-042, R-055, R-056, R-057, R-058, R-060, R-061, R-062, R-067, R-068, R-069, R-070, R-074, R-076, R-097, R-099, R-105, R-106, R-107, R-108, R-110, R-111, R-125, R-128, R-129, R-130]
          test_ids:
            - TEST-AM-004-DOMAIN-001
            - TEST-AM-004-TOOL-001
            - TEST-AM-004-PERSIST-001
            - TEST-AM-004-SMOKE-001
          evidence_ids:
            - EVD-AM-004-001
        parameters:
          - name: title
            type: string
            required: true
            constraints:
              min_length: 1
              max_length: 200
          - name: category
            type: string
            required: true
            constraints:
              min_length: 1
              max_length: 100

      - id: AM-005
        name: Complete task
        lifecycle_status: active
        owner: tasks_domain
        version: 1
        classification:
          verb: complete
          object: task
          domains: [business, home, workshop, shared]
          capability: tasks
        policy_overlay: internal_mutation
        sensitivity:
          mode: fixed
          value: private
        execution:
          external_side_effects:
            mode: false
          offline_support: true
        idempotency:
          enabled: true
          key_strategy: normalized_payload_hash
          scope: owner_project_action_family
          replay_policy: return_original_result
          collision_policy: reject_and_log
        bindings:
          executor_id: TOOL-TASKS-COMPLETE
          state_target_id: STORE-TASKS
          tool_contract_version: "1"
        state_impact:
          entity: task
          from: [incomplete]
          to: completed
        reconciliation:
          required: false
        traceability:
          requirements:
            primary: [R-028, R-073, R-074]
            supporting: [R-039, R-040, R-041, R-042, R-055, R-056, R-057, R-058, R-060, R-061, R-062, R-067, R-068, R-069, R-070, R-075, R-076, R-097, R-098, R-099, R-105, R-106, R-107, R-108, R-110, R-111, R-125, R-128, R-129, R-130]
          test_ids:
            - TEST-AM-005-DOMAIN-001
            - TEST-AM-005-TOOL-001
            - TEST-AM-005-PERSIST-001
            - TEST-AM-005-SMOKE-001
          evidence_ids:
            - EVD-AM-005-001
        parameters:
          - name: task_id
            type: string
            required: true

      - id: AM-006
        name: Create reminder
        lifecycle_status: active
        owner: reminders_domain
        version: 1
        classification:
          verb: create
          object: reminder
          domains: [business, home, workshop, shared]
          capability: reminders
        policy_overlay: internal_mutation
        sensitivity:
          mode: fixed
          value: private
        execution:
          external_side_effects:
            mode: false
          offline_support: true
        idempotency:
          enabled: true
          key_strategy: normalized_payload_hash
          scope: owner_project_action_family
          replay_policy: return_original_result
          collision_policy: reject_and_log
        bindings:
          executor_id: TOOL-REMINDERS-CREATE
          state_target_id: STORE-REMINDERS
          tool_contract_version: "1"
        state_impact:
          entity: reminder
          transition: create
        reconciliation:
          required: false
        traceability:
          requirements:
            primary: [R-001, R-067, R-084, R-085]
            supporting: [R-039, R-040, R-041, R-042, R-055, R-056, R-057, R-058, R-060, R-061, R-062, R-068, R-069, R-070, R-073, R-074, R-076, R-090, R-097, R-099, R-105, R-106, R-107, R-108, R-110, R-111, R-125, R-128, R-129, R-130]
          test_ids:
            - TEST-AM-006-DOMAIN-001
            - TEST-AM-006-TOOL-001
            - TEST-AM-006-PERSIST-001
            - TEST-AM-006-SMOKE-001
          evidence_ids:
            - EVD-AM-006-001
        parameters:
          - name: title
            type: string
            required: true
            constraints:
              min_length: 1
              max_length: 200
          - name: due_raw
            type: string
            required: false
          - name: due_at
            type: number
            required: false
          - name: due_timezone
            type: string
            required: false

      - id: AM-007
        name: Cancel reminder
        lifecycle_status: active
        owner: reminders_domain
        version: 1
        classification:
          verb: cancel
          object: reminder
          domains: [business, home, workshop, shared]
          capability: reminders
        policy_overlay: destructive_internal_mutation
        policy_overrides:
          approver_scope: owner
        sensitivity:
          mode: fixed
          value: private
        execution:
          external_side_effects:
            mode: false
          offline_support: true
        approval:
          mode: always
          binding: exact_action_fingerprint
          fingerprint_fields:
            - action_family_id
            - owner_id
            - project_id
            - reminder_id
        idempotency:
          enabled: true
          key_strategy: normalized_payload_hash
          scope: owner_project_action_family
          replay_policy: return_original_result
          collision_policy: reject_and_log
        bindings:
          executor_id: TOOL-REMINDERS-CANCEL
          state_target_id: STORE-REMINDERS
          tool_contract_version: "1"
        state_impact:
          entity: reminder
          from: [present]
          to: cancelled_tombstone
          live_record: deleted
          retained_result: internalActionResults
        reconciliation:
          required: false
        traceability:
          requirements:
            primary: [R-073, R-074, R-083]
            supporting: [R-039, R-040, R-041, R-042, R-044, R-045, R-046, R-047, R-048, R-049, R-050, R-055, R-056, R-057, R-058, R-059, R-060, R-061, R-062, R-067, R-068, R-069, R-070, R-075, R-076, R-078, R-079, R-081, R-087, R-097, R-098, R-099, R-105, R-106, R-107, R-108, R-110, R-111, R-125, R-128, R-129, R-130]
          test_ids:
            - TEST-AM-007-DOMAIN-001
            - TEST-AM-007-TOOL-001
            - TEST-AM-007-PERSIST-001
            - TEST-AM-007-SMOKE-001
          evidence_ids:
            - EVD-AM-007-001
        parameters:
          - name: reminder_id
            type: string
            required: true

    """
)
action_path.write_text(action_text.replace(marker, families + marker, 1), encoding="utf-8")

overlay_path = Path("docs/registries/policy-overlays.yaml")
replace_once(
    overlay_path,
    "  - name: send_with_approval\n    effect_class: send\n",
    "  - name: destructive_internal_mutation\n    effect_class: destructive\n  - name: send_with_approval\n    effect_class: send\n",
    "policy overlay registry",
)

tool_entries = dedent(
    """\
      - id: TOOL-TASKS-CREATE
        lifecycle_status: active
        implemented: true
        description: Creates owner/project-scoped durable tasks through the reviewed tasks:create allowlist binding, commissioned on dev:outgoing-ram-798.
        implementation: typescript/src/actions/taskReminderTools.ts
        adapter: typescript/src/persistence/convexControlledTasks.ts
        allowlist: typescript/src/actions/toolExecutionFactory.ts
        bound_by: [AM-004]

      - id: TOOL-TASKS-COMPLETE
        lifecycle_status: active
        implemented: true
        description: Atomically completes an owner/project-scoped task with fingerprint-bound replay through tasks:complete, commissioned on dev:outgoing-ram-798.
        implementation: typescript/src/actions/taskReminderTools.ts
        adapter: typescript/src/persistence/convexControlledTasks.ts
        allowlist: typescript/src/actions/toolExecutionFactory.ts
        bound_by: [AM-005]

      - id: TOOL-REMINDERS-CREATE
        lifecycle_status: active
        implemented: true
        description: Creates owner/project-scoped durable reminders with preserved and normalized due metadata through reminders:create, commissioned on dev:outgoing-ram-798.
        implementation: typescript/src/actions/taskReminderTools.ts
        adapter: typescript/src/persistence/convexControlledReminders.ts
        allowlist: typescript/src/actions/toolExecutionFactory.ts
        bound_by: [AM-006]

      - id: TOOL-REMINDERS-CANCEL
        lifecycle_status: active
        implemented: true
        description: Cancels owner/project-scoped reminders through a T3-approved fingerprint-bound tombstone mutation before deleting the live record, commissioned on dev:outgoing-ram-798.
        implementation: typescript/src/actions/taskReminderTools.ts
        adapter: typescript/src/persistence/convexControlledReminders.ts
        allowlist: typescript/src/actions/toolExecutionFactory.ts
        bound_by: [AM-007]

    """
)
tool_path = Path("docs/registries/tool-registry.yaml")
replace_once(tool_path, "  - id: TOOL-QUOTE-FINALIZE\n", tool_entries + "  - id: TOOL-QUOTE-FINALIZE\n", "tool registry")

state_entries = dedent(
    """\
      - id: STORE-TASKS
        lifecycle_status: active
        implemented: true
        description: Owner/project-scoped Convex tasks with revision metadata and atomic internal-action results for create and complete, commissioned on dev:outgoing-ram-798.
        implementation:
          - typescript/convex/schema.ts
          - typescript/convex/tasks.ts
          - typescript/src/persistence/convexControlledTasks.ts
        bound_by: [AM-004, AM-005]

      - id: STORE-REMINDERS
        lifecycle_status: active
        implemented: true
        description: Owner/project-scoped Convex reminders with preserved due text, normalized due metadata, revisions, cancellation tombstones and atomic internal-action results, commissioned on dev:outgoing-ram-798.
        implementation:
          - typescript/convex/schema.ts
          - typescript/convex/reminders.ts
          - typescript/src/persistence/convexControlledReminders.ts
        bound_by: [AM-006, AM-007]

    """
)
state_path = Path("docs/registries/state-target-registry.yaml")
replace_once(state_path, "  - id: STORE-QUOTES\n", state_entries + "  - id: STORE-QUOTES\n", "state target registry")

append_entries(
    Path("docs/registries/test-id-registry.yaml"),
    dedent(
        """\
          - id: TEST-AM-004-DOMAIN-001
            path: typescript/tests/controlledTaskActions.test.ts
            verifies: task create exact replay, fingerprint collision rejection, project isolation, and initial revision semantics
          - id: TEST-AM-004-TOOL-001
            path: typescript/tests/taskReminderAllowlist.test.ts
            verifies: tasks:create strict schema, immutable execution context, authority, dry-run and exact allowlist enforcement
          - id: TEST-AM-004-PERSIST-001
            path: typescript/tests/convexControlledTasks.test.ts
            verifies: authenticated task creation, mapping, project scope and cleanup adapter calls
          - id: TEST-AM-004-SMOKE-001
            path: typescript/tests/taskReminderActionsSmoke.test.ts
            verifies: task create, fresh-instance replay, fresh visibility and self-cleaning development execution

          - id: TEST-AM-005-DOMAIN-001
            path: typescript/tests/controlledTaskActions.test.ts
            verifies: atomic completion decision, exact completion replay, stale completion rejection and revision advancement
          - id: TEST-AM-005-TOOL-001
            path: typescript/tests/taskReminderAllowlist.test.ts
            verifies: tasks:complete strict target validation, stale or inaccessible target failure and unreviewed operation blocking
          - id: TEST-AM-005-PERSIST-001
            path: typescript/tests/convexControlledTasks.test.ts
            verifies: authenticated complete, get and cleanup adapter context and null preservation
          - id: TEST-AM-005-SMOKE-001
            path: typescript/tests/taskReminderActionsSmoke.test.ts
            verifies: live task completion, retained replay result, fresh visibility and cleanup

          - id: TEST-AM-006-DOMAIN-001
            path: typescript/tests/controlledReminderActions.test.ts
            verifies: reminder create exact replay, fingerprint collision rejection, project isolation and due metadata preservation
          - id: TEST-AM-006-TOOL-001
            path: typescript/tests/taskReminderAllowlist.test.ts
            verifies: reminders:create due-field coupling, authority, dry-run and exact allowlist enforcement
          - id: TEST-AM-006-PERSIST-001
            path: typescript/tests/convexControlledReminders.test.ts
            verifies: authenticated reminder creation, optional due mapping, project scope and cleanup adapter calls
          - id: TEST-AM-006-SMOKE-001
            path: typescript/tests/taskReminderActionsSmoke.test.ts
            verifies: reminder create, fresh-instance replay, fresh visibility and self-cleaning development execution

          - id: TEST-AM-007-DOMAIN-001
            path: typescript/tests/controlledReminderActions.test.ts
            verifies: cancellation tombstone retention, live-record deletion, exact replay, collision rejection and stale cancellation behaviour
          - id: TEST-AM-007-TOOL-001
            path: typescript/tests/taskReminderAllowlist.test.ts
            verifies: reminders:cancel target validation, execution-context propagation and rejection outside the reviewed allowlist
          - id: TEST-AM-007-PERSIST-001
            path: typescript/tests/convexControlledReminders.test.ts
            verifies: authenticated cancel, retained result mapping, get and cleanup adapter context
          - id: TEST-AM-007-SMOKE-001
            path: typescript/tests/taskReminderActionsSmoke.test.ts
            verifies: live cancellation tombstone replay after deletion and authenticated post-run cleanup
        """
    ),
)

append_entries(
    Path("docs/registries/evidence-id-registry.yaml"),
    dedent(
        """\
          - id: EVD-AM-004-001
            path: docs/evidence/task-reminder-actions-commissioning.md
            description: Runtime CI and authorised development create-task sync, replay, visibility and cleanup evidence
          - id: EVD-AM-005-001
            path: docs/evidence/task-reminder-actions-commissioning.md
            description: Runtime CI and authorised development complete-task transition, replay and cleanup evidence
          - id: EVD-AM-006-001
            path: docs/evidence/task-reminder-actions-commissioning.md
            description: Runtime CI and authorised development create-reminder sync, replay, visibility and cleanup evidence
          - id: EVD-AM-007-001
            path: docs/evidence/task-reminder-actions-commissioning.md
            description: Runtime CI and authorised development cancellation tombstone, replay, live-record deletion and cleanup evidence
        """
    ),
)

evidence_dir = Path("docs/evidence")
evidence_dir.mkdir(parents=True, exist_ok=True)
(evidence_dir / "task-reminder-actions-commissioning.md").write_text(
    dedent(
        """\
        # Task and Reminder Actions — Development Commissioning Evidence

        ## Disposition

        `AM-004 Create task`, `AM-005 Complete task`, `AM-006 Create reminder`, and `AM-007 Cancel reminder` are commissioned as active action families on the authorised Convex development deployment.

        This record does not authorise or record a Convex or Manufact production deployment.

        ## Verified revisions

        - Runtime implementation merge: `48a7b69390eef65d010581d4b2ebe1c382ed50b7` (PR #161)
        - Commissioning harness merge: `5fc8c3f477bfa9ce121b56575b0336105c37de8f` (PR #162)
        - Commissioning workflow source: `77ba3197d6525fec1b172ac47b852a698977b695`
        - GitHub Actions workflow run: `30065629012`
        - Commissioning job: `89395897530`
        - Evidence artifact: `8586149430`
        - Artifact name: `task-reminder-development-commissioning-30065629012`
        - Artifact digest: `sha256:f061c997413034144bfe82bfb50c49bec579019168f1ac0076c384b19fa7883a`
        - Evidence issue comment: https://github.com/Benny3840/Jarvis/issues/155#issuecomment-5066008811

        ## Authorised target

        - Deployment: `dev:outgoing-ram-798`
        - URL: `https://outgoing-ram-798.convex.cloud`
        - Production deployment: **not authorised and not performed**

        ## Passed gates

        - Locked dependency installation and complete `npm run check`
        - Convex function sync using `npx convex dev --once`
        - Task create and mutation-level idempotent replay
        - Fresh-client task persistence visibility
        - Task completion, revision advancement, and exact replay
        - Reminder create and mutation-level idempotent replay
        - Fresh-client reminder persistence visibility
        - Cancellation tombstone retained before live-record deletion
        - Cancellation replay after live-record deletion
        - Authenticated cleanup and post-cleanup absence
        - Development-only target guard

        ## Bound implementation

        - `AM-004` → `TOOL-TASKS-CREATE` → `tasks:create` → `STORE-TASKS`
        - `AM-005` → `TOOL-TASKS-COMPLETE` → `tasks:complete` → `STORE-TASKS`
        - `AM-006` → `TOOL-REMINDERS-CREATE` → `reminders:create` → `STORE-REMINDERS`
        - `AM-007` → `TOOL-REMINDERS-CANCEL` → `reminders:cancel` → `STORE-REMINDERS`

        ## Preserved boundaries

        - `AM-012 Finalize quote` remains planned.
        - `AM-013 Send quote` remains planned.
        - External reconciliation remains required before any sending capability is activated.
        - Manufact core production remains locked to inactive deployment branches.
        """
    ),
    encoding="utf-8",
)

plan_path = Path("docs/superpowers/plans/2026-07-24-task-reminder-actions.md")
plan = plan_path.read_text(encoding="utf-8")
for old, new in (
    ("- [ ] Merge runtime with action families still absent/planned.", "- [x] Merge runtime with action families still absent/planned."),
    ("- [ ] Sync only `dev:outgoing-ram-798` and run the live self-cleaning smoke.", "- [x] Sync only `dev:outgoing-ram-798` and run the live self-cleaning smoke."),
    ("- [ ] Add AM-004 through AM-007, tool/store catalogs, TEST/EVD IDs and evidence.", "- [x] Add AM-004 through AM-007, tool/store catalogs, TEST/EVD IDs and evidence."),
    ("- [ ] Regenerate the action map and pass final governance validation.", "- [x] Regenerate the action map and pass final governance validation."),
):
    if old not in plan:
        raise SystemExit(f"implementation-plan checkpoint missing: {old}")
    plan = plan.replace(old, new, 1)
plan_path.write_text(plan, encoding="utf-8")
