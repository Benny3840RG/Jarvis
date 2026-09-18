import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chelseaHeightsPavingInput,
  chelseaHeightsPavingOptionInputs,
} from "../src/quoting/fixtures/pavingChelseaHeights.js";
import {
  buildPavingConditions,
  buildPavingProfile,
  buildPavingScope,
  calculatePavingOptionTotals,
} from "../src/quoting/pavingProfile.js";

describe("calculatePavingOptionTotals", () => {
  it("calculates the full-area option: $12,500 total, $3,750 deposit, $8,750 balance", () => {
    const totals = calculatePavingOptionTotals(12500, 30);
    assert.equal(totals.amountIncGst, 12500);
    assert.equal(totals.deposit, 3750);
    assert.equal(totals.balance, 8750);
  });

  it("calculates the courtyard-only option: $7,950 total, $2,385 deposit, $5,565 balance", () => {
    const totals = calculatePavingOptionTotals(7950, 30);
    assert.equal(totals.amountIncGst, 7950);
    assert.equal(totals.deposit, 2385);
    assert.equal(totals.balance, 5565);
  });
});

describe("buildPavingScope", () => {
  it("includes the paver specification, excavation, base, bedding, access and drainage details", () => {
    const scope = buildPavingScope(chelseaHeightsPavingInput);
    const scopeText = scope.join("\n");

    assert.match(scopeText, /600 x 600 x 40 mm textured charcoal concrete pavers/);
    assert.match(scopeText, /excavate.*170 mm/i);
    assert.match(scopeText, /crushed rock base.*100 mm/i);
    assert.match(scopeText, /bedding sand.*30 mm/i);
    assert.match(scopeText, /810 mm garage access/i);
    assert.match(scopeText, /falls.*toward existing drainage/i);
  });

  it("mentions retained features such as the palm", () => {
    const scope = buildPavingScope(chelseaHeightsPavingInput);
    assert.ok(scope.some((line) => line.includes("the palm")));
  });
});

describe("buildPavingConditions", () => {
  it("includes underground services, access, concealed conditions and variation wording", () => {
    const conditions = buildPavingConditions(chelseaHeightsPavingInput);
    const conditionsText = conditions.join("\n");

    assert.match(conditionsText, /underground services/i);
    assert.match(conditionsText, /access/i);
    assert.match(conditionsText, /concealed conditions/i);
    assert.match(conditionsText, /variation/i);
  });

  it("also covers boundaries, levels, drainage, paver suitability, clearing, roots/obstructions, natural stone, concrete slabs and sealing", () => {
    const conditionsText = buildPavingConditions(chelseaHeightsPavingInput).join("\n");

    assert.match(conditionsText, /boundaries/i);
    assert.match(conditionsText, /levels/i);
    assert.match(conditionsText, /drainage/i);
    assert.match(conditionsText, /paver suitability/i);
    assert.match(conditionsText, /clearing furniture/i);
    assert.match(conditionsText, /roots/i);
    assert.match(conditionsText, /obstructions/i);
    assert.match(conditionsText, /natural stone/i);
    assert.match(conditionsText, /concrete slab/i);
    assert.match(conditionsText, /sealing/i);
  });
});

describe("buildPavingProfile", () => {
  const profile = buildPavingProfile(chelseaHeightsPavingInput, chelseaHeightsPavingOptionInputs);

  it("carries the input through unchanged", () => {
    assert.deepEqual(profile.input, chelseaHeightsPavingInput);
  });

  it("generates a project objective mentioning the project title and property address", () => {
    assert.match(profile.objective, /Courtyard and side-area paving/);
    assert.match(profile.objective, /Chelsea Heights/);
  });

  it("generates scope and exclusions/conditions matching the standalone builder functions", () => {
    assert.deepEqual(profile.scope, buildPavingScope(chelseaHeightsPavingInput));
    assert.deepEqual(
      profile.exclusionsAndConditions,
      buildPavingConditions(chelseaHeightsPavingInput),
    );
  });

  it("produces the full-area option at $12,500 total, $3,750 deposit, $8,750 balance", () => {
    const fullArea = profile.options.find((option) => option.name === "Full-area paving");
    assert.ok(fullArea);
    assert.equal(fullArea.areaSquareMetres, 52.9);
    assert.equal(fullArea.amountIncGst, 12500);
    assert.equal(fullArea.deposit, 3750);
    assert.equal(fullArea.balance, 8750);
  });

  it("produces the courtyard-only option at $7,950 total, $2,385 deposit, $5,565 balance", () => {
    const courtyardOnly = profile.options.find((option) => option.name === "Courtyard-only paving");
    assert.ok(courtyardOnly);
    assert.equal(courtyardOnly.areaSquareMetres, 30.7);
    assert.equal(courtyardOnly.amountIncGst, 7950);
    assert.equal(courtyardOnly.deposit, 2385);
    assert.equal(courtyardOnly.balance, 5565);
  });
});
