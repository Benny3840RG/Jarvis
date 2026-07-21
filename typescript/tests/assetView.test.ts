import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Asset } from "../src/assets/asset.js";
import { deriveAssetView } from "../src/assets/assetView.js";

const MS_PER_DAY = 86_400_000;

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "a1",
    name: "Ride-on mower",
    kind: "machine",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("deriveAssetView", () => {
  it("marks an asset due when the next service has passed", () => {
    const now = 1_000 * MS_PER_DAY;
    const view = deriveAssetView(
      asset({ serviceIntervalDays: 30, lastServicedAt: now - 40 * MS_PER_DAY }),
      now,
    );
    assert.equal(view.nextDueAt, now - 10 * MS_PER_DAY);
    assert.equal(view.due, true);
  });

  it("is not due when the next service is still in the future", () => {
    const now = 1_000 * MS_PER_DAY;
    const view = deriveAssetView(
      asset({ serviceIntervalDays: 30, lastServicedAt: now - 5 * MS_PER_DAY }),
      now,
    );
    assert.equal(view.nextDueAt, now + 25 * MS_PER_DAY);
    assert.equal(view.due, false);
  });

  it("has no due date when the interval or last-serviced date is missing", () => {
    const now = 1_000 * MS_PER_DAY;
    assert.equal(deriveAssetView(asset({ serviceIntervalDays: 30 }), now).nextDueAt, undefined);
    assert.equal(deriveAssetView(asset({ serviceIntervalDays: 30 }), now).due, false);
    assert.equal(deriveAssetView(asset({ lastServicedAt: now }), now).nextDueAt, undefined);
    assert.equal(deriveAssetView(asset(), now).due, false);
  });
});
