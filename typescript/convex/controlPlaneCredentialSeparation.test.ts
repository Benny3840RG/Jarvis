import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireApprovalToken, requireDeliveryRuntimeToken } from "./authHelpers.js";

const SERVICE_TOKEN = "control-plane-service-token-000000000000";
const SERVICE_TOKEN_PREVIOUS = "control-plane-service-previous-000000000";
const APPROVAL_TOKEN = "control-plane-approval-token-00000000000";
const DELIVERY_RUNTIME_TOKEN = "control-plane-delivery-token-00000000000";

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
  vi.stubEnv("JARVIS_SERVICE_TOKEN_PREVIOUS", SERVICE_TOKEN_PREVIOUS);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", APPROVAL_TOKEN);
  vi.stubEnv("JARVIS_DELIVERY_RUNTIME_TOKEN", DELIVERY_RUNTIME_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("control-plane credential separation", () => {
  it("rejects approval and delivery credentials that overlap across rotation slots", () => {
    vi.stubEnv("JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS", APPROVAL_TOKEN);

    expect(() => requireApprovalToken(APPROVAL_TOKEN)).toThrow(/distinct/i);
  });

  it("rejects a runtime credential that matches the previous service token", () => {
    vi.stubEnv("JARVIS_APPROVAL_TOKEN", SERVICE_TOKEN_PREVIOUS);

    expect(() => requireApprovalToken(SERVICE_TOKEN_PREVIOUS)).toThrow(/distinct/i);
  });

  it("accepts independent approval and delivery credentials", () => {
    expect(() => requireApprovalToken(APPROVAL_TOKEN)).not.toThrow();
    expect(() => requireDeliveryRuntimeToken(DELIVERY_RUNTIME_TOKEN)).not.toThrow();
  });
});
