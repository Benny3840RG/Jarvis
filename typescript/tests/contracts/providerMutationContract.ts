/**
 * Provider mutation contract.
 *
 * One table of cases that every persistence backend must satisfy, driven
 * through the real `PersistenceProvider` (and, where a backend has it,
 * `ControlledTaskStore`) classes. Runner-agnostic: it throws plain Errors so
 * the node:test JSON runner and the vitest/convex-test Convex runner can both
 * execute it.
 *
 * Backends do not expose identical APIs. Each harness declares capabilities;
 * a case that needs a capability the harness lacks is reported as skipped by
 * the runner, so the gap stays visible instead of silently passing.
 *
 *   - direct:      PersistenceProvider CRUD + restore (all backends)
 *   - controlled:  ControlledTaskStore (Convex only today)
 *   - serviceAuth: service-token authentication (Convex only; JSON is a
 *                  local file with no caller identity)
 */

import type { PersistenceProvider, Task } from "../../src/persistence/types.js";
import type { ControlledTaskStore, InternalActionContext } from "../../src/tasks/controlledTask.js";

export type ContractCapability = "direct" | "controlled" | "serviceAuth";

export type ContractHarness = {
  provider: PersistenceProvider;
  controlledTasks?: ControlledTaskStore;
  /** Same backing store, presented with a rejected credential. */
  unauthorisedProvider?: PersistenceProvider;
};

export type ContractCase = {
  name: string;
  requires: ContractCapability;
  run(harness: ContractHarness): Promise<void>;
};

export function harnessCapabilities(harness: ContractHarness): Set<ContractCapability> {
  const capabilities = new Set<ContractCapability>(["direct"]);
  if (harness.controlledTasks) capabilities.add("controlled");
  if (harness.unauthorisedProvider) capabilities.add("serviceAuth");
  return capabilities;
}

const PROJECT_ID = "project-1";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Contract violation: ${message}`);
}

async function rejects(promise: Promise<unknown>, pattern: RegExp, message: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught: unknown) {
    error = caught;
  }
  check(error !== undefined, `${message}: expected rejection, operation succeeded`);
  const text = error instanceof Error ? error.message : String(error);
  check(pattern.test(text), `${message}: expected ${String(pattern)}, got "${text}"`);
}

/** Seeds one project-scoped and one personal task/reminder through restore. */
async function seed(provider: PersistenceProvider) {
  check(provider.restoreSnapshotIntoEmpty, "provider must support restore into empty storage");
  await provider.restoreSnapshotIntoEmpty({
    state: { taskId: "src-project-task", reminderId: "src-project-reminder" },
    tasks: [
      {
        id: "src-project-task",
        projectId: PROJECT_ID,
        title: "Project task",
        completed: false,
        category: "workshop",
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
      },
      {
        id: "src-personal-task",
        title: "Personal task",
        completed: false,
        category: "home",
        createdAt: 2,
      },
    ],
    reminders: [
      {
        id: "src-project-reminder",
        projectId: PROJECT_ID,
        title: "Project reminder",
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
      },
      { id: "src-personal-reminder", title: "Personal reminder", createdAt: 2 },
    ],
  });
  const tasks = await provider.listTasks();
  const reminders = await provider.listReminders();
  const projectTask = tasks.find((task) => task.title === "Project task");
  const personalTask = tasks.find((task) => task.title === "Personal task");
  const projectReminder = reminders.find((reminder) => reminder.title === "Project reminder");
  const personalReminder = reminders.find((reminder) => reminder.title === "Personal reminder");
  check(projectTask && personalTask, "restored tasks must be listed");
  check(projectReminder && personalReminder, "restored reminders must be listed");
  return { projectTask, personalTask, projectReminder, personalReminder };
}

async function taskById(provider: PersistenceProvider, id: string): Promise<Task | undefined> {
  return (await provider.listTasks()).find((task) => task.id === id);
}

function context(key: string, projectId = PROJECT_ID): InternalActionContext {
  return {
    projectId,
    idempotencyKey: key,
    actionFingerprint: `fingerprint-${key}`,
    sourceRequestId: `request-${key}`,
    correlationId: `correlation-${key}`,
    source: "provider-contract",
  };
}

const CONTROLLED_TASK = /controlled task execution/i;
const CONTROLLED_REMINDER = /controlled reminder execution/i;

export const providerMutationContract: readonly ContractCase[] = [
  {
    name: "restore preserves projectId on tasks and reminders",
    requires: "direct",
    async run({ provider }) {
      const { projectTask, personalTask, projectReminder, personalReminder } = await seed(provider);
      check(projectTask.projectId === PROJECT_ID, "project task keeps projectId");
      check(projectReminder.projectId === PROJECT_ID, "project reminder keeps projectId");
      check(personalTask.projectId === undefined, "personal task has no projectId");
      check(personalReminder.projectId === undefined, "personal reminder has no projectId");
    },
  },
  {
    name: "personal task: update, complete, re-complete and remove are allowed",
    requires: "direct",
    async run({ provider }) {
      const created = await provider.addTask("Fresh task", "home");
      check(created.projectId === undefined, "direct create never assigns projectId");
      const updated = await provider.updateTask(created.id, { title: "Renamed" });
      check(updated?.title === "Renamed", "update applies");
      check((await provider.completeTask(created.id))?.completed === true, "complete applies");
      const again = await provider.completeTask(created.id);
      check(again?.completed === true, "re-complete is a no-op that still reports completed");
      check((await provider.removeTask(created.id))?.id === created.id, "remove returns record");
      check((await taskById(provider, created.id)) === undefined, "removed task is gone");
    },
  },
  {
    name: "unknown ids return null for every direct mutation",
    requires: "direct",
    async run({ provider }) {
      check((await provider.updateTask("missing-id", { title: "x" })) === null, "updateTask");
      check((await provider.completeTask("missing-id")) === null, "completeTask");
      check((await provider.removeTask("missing-id")) === null, "removeTask");
      check((await provider.updateReminder("missing-id", { title: "x" })) === null, "update rem");
      check((await provider.removeReminder("missing-id")) === null, "removeReminder");
    },
  },
  {
    name: "project-scoped task rejects direct update, complete and remove, unchanged",
    requires: "direct",
    async run({ provider }) {
      const { projectTask } = await seed(provider);
      await rejects(provider.updateTask(projectTask.id, { title: "x" }), CONTROLLED_TASK, "update");
      await rejects(provider.completeTask(projectTask.id), CONTROLLED_TASK, "complete");
      await rejects(provider.removeTask(projectTask.id), CONTROLLED_TASK, "remove");
      const after = await taskById(provider, projectTask.id);
      check(after?.title === "Project task", "title unchanged");
      check(after.completed === false, "still incomplete");
      check(after.projectId === PROJECT_ID, "projectId unchanged");
    },
  },
  {
    name: "project-scoped reminder rejects direct update and remove, unchanged",
    requires: "direct",
    async run({ provider }) {
      const { projectReminder } = await seed(provider);
      await rejects(
        provider.updateReminder(projectReminder.id, { title: "x" }),
        CONTROLLED_REMINDER,
        "update",
      );
      await rejects(provider.removeReminder(projectReminder.id), CONTROLLED_REMINDER, "remove");
      const after = (await provider.listReminders()).find((r) => r.id === projectReminder.id);
      check(after?.title === "Project reminder", "title unchanged");
      check(after.projectId === PROJECT_ID, "projectId unchanged");
    },
  },
  {
    name: "personal reminder: update and remove are allowed",
    requires: "direct",
    async run({ provider }) {
      const { personalReminder } = await seed(provider);
      const updated = await provider.updateReminder(personalReminder.id, { title: "Renamed" });
      check(updated?.title === "Renamed", "update applies");
      check((await provider.removeReminder(personalReminder.id))?.id === personalReminder.id, "rm");
    },
  },
  {
    name: "controlled complete of a project task succeeds, bumps revision, is idempotent",
    requires: "controlled",
    async run({ provider, controlledTasks }) {
      check(controlledTasks, "controlled store");
      const { projectTask } = await seed(provider);
      const first = await controlledTasks.complete({ ...context("k1"), taskId: projectTask.id });
      check(first?.completed === true, "controlled complete applies");
      check(first.revision === 2, `revision bumps to 2, got ${String(first.revision)}`);
      const replay = await controlledTasks.complete({ ...context("k1"), taskId: projectTask.id });
      check(replay?.revision === 2, "same idempotency key replays the original result");
      check((await taskById(provider, projectTask.id))?.completed === true, "visible to direct");
    },
  },
  {
    name: "controlled complete refuses the wrong project and personal tasks",
    requires: "controlled",
    async run({ provider, controlledTasks }) {
      check(controlledTasks, "controlled store");
      const { projectTask, personalTask } = await seed(provider);
      const wrongProject = await controlledTasks.complete({
        ...context("k2", "project-2"),
        taskId: projectTask.id,
      });
      check(wrongProject === null, "another project cannot complete this task");
      const personal = await controlledTasks.complete({
        ...context("k3"),
        taskId: personalTask.id,
      });
      check(personal === null, "controlled path cannot claim a personal task");
      check((await taskById(provider, projectTask.id))?.completed === false, "project untouched");
      check((await taskById(provider, personalTask.id))?.completed === false, "personal untouched");
    },
  },
  {
    name: "direct mutation stays rejected after a controlled change",
    requires: "controlled",
    async run({ provider, controlledTasks }) {
      check(controlledTasks, "controlled store");
      const { projectTask } = await seed(provider);
      await controlledTasks.complete({ ...context("k4"), taskId: projectTask.id });
      await rejects(provider.removeTask(projectTask.id), CONTROLLED_TASK, "remove after control");
    },
  },
  {
    name: "rejected credential cannot read or mutate, and changes nothing",
    requires: "serviceAuth",
    async run({ provider, unauthorisedProvider }) {
      check(unauthorisedProvider, "unauthorised provider");
      const { personalTask, personalReminder } = await seed(provider);
      const denied = /unauthori[sz]ed|invalid service token|not authori[sz]ed/i;
      await rejects(unauthorisedProvider.listTasks(), denied, "listTasks");
      await rejects(unauthorisedProvider.addTask("Intruder", "home"), denied, "addTask");
      await rejects(
        unauthorisedProvider.updateTask(personalTask.id, { title: "x" }),
        denied,
        "updateTask",
      );
      await rejects(unauthorisedProvider.completeTask(personalTask.id), denied, "completeTask");
      await rejects(unauthorisedProvider.removeTask(personalTask.id), denied, "removeTask");
      await rejects(
        unauthorisedProvider.removeReminder(personalReminder.id),
        denied,
        "removeReminder",
      );
      const tasks = await provider.listTasks();
      check(tasks.length === 2, "no task added or removed");
      check(
        tasks.find((t) => t.id === personalTask.id)?.title === "Personal task",
        "task unchanged",
      );
    },
  },
];
