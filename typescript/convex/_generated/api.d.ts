/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as assistantState from "../assistantState.js";
import type * as auditEvents from "../auditEvents.js";
import type * as authHelpers from "../authHelpers.js";
import type * as projectRecords from "../projectRecords.js";
import type * as projects from "../projects.js";
import type * as reminders from "../reminders.js";
import type * as tasks from "../tasks.js";
import type * as totalityValidators from "../totalityValidators.js";
import type * as validationReports from "../validationReports.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  assistantState: typeof assistantState;
  auditEvents: typeof auditEvents;
  authHelpers: typeof authHelpers;
  projectRecords: typeof projectRecords;
  projects: typeof projects;
  reminders: typeof reminders;
  tasks: typeof tasks;
  totalityValidators: typeof totalityValidators;
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
