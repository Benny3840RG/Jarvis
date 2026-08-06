import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findBlockingAdvisories } from "./check-audit.mjs";

describe("console dependency audit parsing", () => {
  it("recognises string, URL and legacy advisory representations", () => {
    const blocking = findBlockingAdvisories({
      vulnerabilities: {
        alpha: {
          via: ["GHSA-aaaa-bbbb-cccc"],
        },
        beta: {
          via: [
            {
              url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
              severity: "high",
              title: "High advisory",
            },
          ],
        },
      },
      advisories: {
        "123": {
          id: 123,
          url: "https://github.com/advisories/GHSA-gggg-hhhh-iiii",
          severity: "moderate",
          title: "Legacy advisory",
        },
      },
    });

    assert.deepEqual(
      blocking.map((advisory) => advisory.id),
      ["GHSA-AAAA-BBBB-CCCC", "GHSA-DDDD-EEEE-FFFF", "GHSA-GGGG-HHHH-IIII"],
    );
  });

  it("fails on blocking advisories without a GHSA identifier instead of ignoring them", () => {
    const blocking = findBlockingAdvisories({
      vulnerabilities: {
        gamma: {
          via: [{ severity: "critical", title: "Unidentified critical advisory" }],
        },
      },
    });
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0]?.severity, "critical");
  });
});
