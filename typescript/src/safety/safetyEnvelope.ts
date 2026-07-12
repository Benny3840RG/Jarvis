export type SafetyResult = { status: "blocked" | "warning" | "ok"; reasons: string[] };

export class SafetyEnvelope {
  evaluate(outputs: unknown[]): SafetyResult {
    if (outputs.length === 0) {
      return { status: "blocked", reasons: ["No execution output was produced."] };
    }
    const reasons: string[] = [];
    for (const output of outputs) {
      if (output && typeof output === "object" && "unsafe" in output) {
        const maybeUnsafe = output as { unsafe?: unknown };
        if (maybeUnsafe.unsafe) reasons.push("A step was marked as unsafe.");
      }
    }
    return { status: reasons.length > 0 ? "warning" : "ok", reasons };
  }
}
