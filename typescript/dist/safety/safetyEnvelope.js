export class SafetyEnvelope {
    evaluate(outputs) {
        if (outputs.length === 0) {
            return { status: "blocked", reasons: ["No execution output was produced."] };
        }
        const reasons = [];
        for (const output of outputs) {
            if (output && typeof output === "object" && "unsafe" in output) {
                const maybeUnsafe = output;
                if (maybeUnsafe.unsafe) {
                    reasons.push("A step was marked as unsafe.");
                }
            }
        }
        return {
            status: reasons.length > 0 ? "warning" : "ok",
            reasons,
        };
    }
}
