export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export type ConsolePageRequest = {
  pageSize?: number;
  taskCursor?: string;
  reminderCursor?: string;
};

export type ConsolePage<Row> = {
  page: Row[];
  isDone: boolean;
  continueCursor: string;
};

type ConsoleCursorState = {
  taskCursor?: string | null;
  reminderCursor?: string | null;
};

type ConsolePaginationState = {
  tasks: unknown[];
  reminders: unknown[];
  pagination: {
    tasks: {
      returnedCount: number;
      requestedPageSize: number;
    };
    reminders: {
      returnedCount: number;
      requestedPageSize: number;
    };
  };
};

export function normaliseConsolePageRequest(request: ConsolePageRequest) {
  const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`Console page size must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return {
    pageSize,
    taskCursor: request.taskCursor ?? null,
    reminderCursor: request.reminderCursor ?? null,
  };
}

function pageMetadata<Row>(result: ConsolePage<Row>, requestedPageSize: number) {
  return {
    isDone: result.isDone,
    continueCursor: result.continueCursor,
    returnedCount: result.page.length,
    requestedPageSize,
  };
}

function requireBoundedPage<Row>(
  domain: "Task" | "Reminder",
  result: ConsolePage<Row>,
  requestedPageSize: number,
) {
  if (
    !Number.isInteger(requestedPageSize) ||
    requestedPageSize < 1 ||
    requestedPageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(`Console page size must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  if (result.page.length > requestedPageSize) {
    throw new Error(`${domain} page returned more rows than requested.`);
  }
}

export function consolePaginationInvariantIssues(value: ConsolePaginationState) {
  const issues: { path: (string | number)[]; message: string }[] = [];
  for (const domain of ["tasks", "reminders"] as const) {
    const rows = value[domain];
    const metadata = value.pagination[domain];
    if (metadata.returnedCount !== rows.length) {
      issues.push({
        path: ["pagination", domain, "returnedCount"],
        message: `${domain} returned count must match the output array length.`,
      });
    }
    if (metadata.returnedCount > metadata.requestedPageSize) {
      issues.push({
        path: ["pagination", domain, "returnedCount"],
        message: `${domain} returned count cannot exceed the requested page size.`,
      });
    }
  }
  return issues;
}

export function bridgeFailureActivity(activity: string[]) {
  return [
    ...activity,
    "Authenticated Console data is temporarily unavailable.",
    "Console failed closed without exposing credentials.",
  ].slice(0, 8);
}

export function buildConsolePageSummary<
  Task extends { completed: boolean },
  Reminder,
>(
  taskPage: ConsolePage<Task>,
  reminderPage: ConsolePage<Reminder>,
  requestedPageSize: number,
  cursorState: ConsoleCursorState = {},
) {
  requireBoundedPage("Task", taskPage, requestedPageSize);
  requireBoundedPage("Reminder", reminderPage, requestedPageSize);
  const active = taskPage.page.filter((task) => !task.completed).length;
  const completed = taskPage.page.length - active;
  const progress =
    taskPage.page.length === 0 ? 100 : Math.round((completed / taskPage.page.length) * 100);

  return {
    counts: {
      active,
      completed,
      reminders: reminderPage.page.length,
      tasksPartial: cursorState.taskCursor != null || !taskPage.isDone,
      remindersPartial: cursorState.reminderCursor != null || !reminderPage.isDone,
    },
    progress,
    pagination: {
      tasks: pageMetadata(taskPage, requestedPageSize),
      reminders: pageMetadata(reminderPage, requestedPageSize),
    },
  };
}

export function formatPartialCount(count: number, partial: boolean) {
  return `${count}${partial ? "+" : ""}`;
}

export function taskProgressLabel(partial: boolean) {
  return partial ? "VISIBLE-PAGE PROGRESS" : "LIVE STATE";
}
