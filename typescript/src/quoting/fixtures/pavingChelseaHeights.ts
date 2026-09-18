import type { PavingJobInput, PavingOptionInput } from "../pavingTypes.js";

/**
 * Regression fixture reproducing Beez Treez quote BT-2026-0915-E
 * (Chelsea Heights — courtyard and side-area paving). The client name and
 * street address were not part of the supplied figures, so placeholders
 * that clearly aren't a real person's details are used; every measurement,
 * specification and price below matches the source quote exactly.
 */
export const chelseaHeightsPavingInput: PavingJobInput = {
  clientName: "Chelsea Heights Client",
  propertyAddress: "Chelsea Heights, VIC",
  projectTitle: "Courtyard and side-area paving",
  fullAreaSquareMetres: 52.9,
  courtyardSquareMetres: 30.7,
  paverSpecification: "600 x 600 x 40 mm textured charcoal concrete pavers",
  paverColourFinish: "Textured charcoal",
  excavationDepth: "approximately 170 mm, subject to ground conditions and finished levels",
  baseThickness: "approximately 100 mm compacted crushed rock",
  beddingSandThickness: "approximately 30 mm bedding sand",
  access: "handling through an 810 mm garage access",
  drainageFall: "toward existing drainage",
  retainedFeatures: ["the palm"],
  knownUndergroundServices: [],
  exclusionsOrConditions: [],
};

export const chelseaHeightsPavingOptionInputs: PavingOptionInput[] = [
  {
    name: "Full-area paving",
    description: "Paving to the full courtyard and side area.",
    areaSquareMetres: chelseaHeightsPavingInput.fullAreaSquareMetres,
    amountIncGst: 12500,
    depositPercentage: 30,
  },
  {
    name: "Courtyard-only paving",
    description: "Paving to the courtyard area only.",
    areaSquareMetres: chelseaHeightsPavingInput.courtyardSquareMetres,
    amountIncGst: 7950,
    depositPercentage: 30,
  },
];
