import { v } from "convex/values";

export const SAFETY_BINDING_VERSION = "jarvis-safety-binding:v1" as const;
export const SAFETY_BINDING_CATEGORIES = [
  "domain",
  "cross-domain",
  "memory",
  "reliability",
  "proposal",
  "tool-action",
] as const;

export const safetyBindingCategoryValidator = v.object({
  category: v.union(
    v.literal("domain"),
    v.literal("cross-domain"),
    v.literal("memory"),
    v.literal("reliability"),
    v.literal("proposal"),
    v.literal("tool-action"),
  ),
  status: v.union(v.literal("pass"), v.literal("blocked")),
  reasons: v.array(v.string()),
});

export const safetyBindingValidator = v.object({
  version: v.literal(SAFETY_BINDING_VERSION),
  phase: v.union(
    v.literal("reasoning"),
    v.literal("memory-proposal"),
    v.literal("memory-apply"),
    v.literal("tool-stage"),
    v.literal("tool-approve"),
    v.literal("tool-revoke"),
    v.literal("tool-execute"),
    v.literal("tool-reconcile"),
  ),
  status: v.union(v.literal("pass"), v.literal("blocked")),
  categories: v.array(safetyBindingCategoryValidator),
});

export type SafetyBindingLike = {
  readonly version: string;
  readonly phase: string;
  readonly status: "pass" | "blocked";
  readonly categories: readonly {
    category: (typeof SAFETY_BINDING_CATEGORIES)[number];
    status: "pass" | "blocked";
    readonly reasons: readonly string[];
  }[];
};

export type ConvexSafetyBinding = {
  version: typeof SAFETY_BINDING_VERSION;
  phase:
    | "reasoning"
    | "memory-proposal"
    | "memory-apply"
    | "tool-stage"
    | "tool-approve"
    | "tool-revoke"
    | "tool-execute"
    | "tool-reconcile";
  status: "pass" | "blocked";
  categories: Array<{
    category: (typeof SAFETY_BINDING_CATEGORIES)[number];
    status: "pass" | "blocked";
    reasons: string[];
  }>;
};

export function assertCanonicalSafetyBinding(binding: SafetyBindingLike): void {
  if (binding.version !== SAFETY_BINDING_VERSION) {
    throw new Error("Safety binding version is not supported.");
  }
  if (binding.categories.length !== SAFETY_BINDING_CATEGORIES.length) {
    throw new Error("Safety binding must contain all six categories.");
  }
  binding.categories.forEach((category, index) => {
    if (category.category !== SAFETY_BINDING_CATEGORIES[index]) {
      throw new Error("Safety binding categories are not in canonical order.");
    }
    if (category.reasons.some((reason) => reason.length > 256)) {
      throw new Error("Safety binding reason is too long.");
    }
  });
  const expectedStatus = binding.categories.some((category) => category.status === "blocked")
    ? "blocked"
    : "pass";
  if (binding.status !== expectedStatus) {
    throw new Error("Safety binding status does not match its category decisions.");
  }
}

export function toConvexSafetyBinding(binding: SafetyBindingLike): ConvexSafetyBinding {
  assertCanonicalSafetyBinding(binding);
  return {
    version: SAFETY_BINDING_VERSION,
    phase: binding.phase as ConvexSafetyBinding["phase"],
    status: binding.status,
    categories: binding.categories.map((category) => ({
      category: category.category,
      status: category.status,
      reasons: [...category.reasons],
    })),
  };
}
