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

export function buildConsolePageSummary<
  Task extends { completed: boolean },
  Reminder,
>(
  taskPage: ConsolePage<Task>,
  reminderPage: ConsolePage<Reminder>,
  requestedPageSize: number,
) {
  const active = taskPage.page.filter((task) => !task.completed).length;
  const completed = taskPage.page.length - active;
  const progress =
    taskPage.page.length === 0 ? 100 : Math.round((completed / taskPage.page.length) * 100);

  return {
    counts: {
      active,
      completed,
      reminders: reminderPage.page.length,
      tasksPartial: !taskPage.isDone,
      remindersPartial: !reminderPage.isDone,
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
