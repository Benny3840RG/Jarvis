/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as assets from "../assets.js";
import type * as assistantState from "../assistantState.js";
import type * as auditEvents from "../auditEvents.js";
import type * as authHelpers from "../authHelpers.js";
import type * as buildLogs from "../buildLogs.js";
import type * as builds from "../builds.js";
import type * as memoryChangeSetLogic from "../memoryChangeSetLogic.js";
import type * as memoryChangeSets from "../memoryChangeSets.js";
import type * as memoryChangeSetValidators from "../memoryChangeSetValidators.js";
import type * as preferences from "../preferences.js";
import type * as projectRecords from "../projectRecords.js";
import type * as projects from "../projects.js";
import type * as reasoningJournal from "../reasoningJournal.js";
import type * as reminders from "../reminders.js";
import type * as tasks from "../tasks.js";
import type * as toolActionLogic from "../toolActionLogic.js";
import type * as toolActions from "../toolActions.js";
import type * as toolActionValidators from "../toolActionValidators.js";
import type * as toolExecutionReceipts from "../toolExecutionReceipts.js";
import type * as toolExecutionValidators from "../toolExecutionValidators.js";
import type * as totalityValidators from "../totalityValidators.js";
import type * as upgrades from "../upgrades.js";
import type * as validationReports from "../validationReports.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  assets: typeof assets;
  assistantState: typeof assistantState;
  auditEvents: typeof auditEvents;
  authHelpers: typeof authHelpers;
  buildLogs: typeof buildLogs;
  builds: typeof builds;
  memoryChangeSetLogic: typeof memoryChangeSetLogic;
  memoryChangeSets: typeof memoryChangeSets;
  memoryChangeSetValidators: typeof memoryChangeSetValidators;
  preferences: typeof preferences;
  projectRecords: typeof projectRecords;
  projects: typeof projects;
  reasoningJournal: typeof reasoningJournal;
  reminders: typeof reminders;
  tasks: typeof tasks;
  toolActionLogic: typeof toolActionLogic;
  toolActions: typeof toolActions;
  toolActionValidators: typeof toolActionValidators;
  toolExecutionReceipts: typeof toolExecutionReceipts;
  toolExecutionValidators: typeof toolExecutionValidators;
  totalityValidators: typeof totalityValidators;
  upgrades: typeof upgrades;
  validationReports: typeof validationReports;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
