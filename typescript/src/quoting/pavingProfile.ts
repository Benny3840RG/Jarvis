import type {
  PavingJobInput,
  PavingJobProfile,
  PavingOption,
  PavingOptionInput,
} from "./pavingTypes.js";

/** Rounds to whole cents so repeated percentage math can't drift by fractions of a cent. */
function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function describeFeatureList(label: string, features: string[], ifEmpty: string): string {
  return features.length > 0 ? `${label}: ${features.join(", ")}.` : ifEmpty;
}

/** Standard scope of works, plus the job-specific specification, excavation, base, bedding, access and drainage details. */
export function buildPavingScope(input: PavingJobInput): string[] {
  const scope: string[] = [
    "Remove existing vegetation from the paving area and treat any stumps within the paving footprint.",
    describeFeatureList(
      "Retain and work around",
      input.retainedFeatures,
      "No existing features are to be retained within the paving area.",
    ),
    `Excavate the paving area to ${input.excavationDepth}.`,
    `Prepare and compact a crushed rock base to ${input.baseThickness}.`,
    `Lay bedding sand to ${input.beddingSandThickness}.`,
    `Supply and lay ${input.paverSpecification} in a ${input.paverColourFinish} finish.`,
    "Install edge restraint to all paved edges.",
    "Cut pavers as required to fit the paved area and surrounding fixtures.",
    "Fill joints between pavers.",
    `Grade paving with falls ${input.drainageFall}.`,
    `Access for materials and works: ${input.access}.`,
    "Deliver materials, remove waste, and clean up the site on completion.",
  ];
  return scope;
}

/** Standard conditions and exclusions, plus job-specific known services and access notes. */
export function buildPavingConditions(input: PavingJobInput): string[] {
  const conditions: string[] = [
    "Quoted areas and boundaries are estimates only and are to be confirmed on site prior to commencement.",
    "Existing site levels are assumed suitable for paving; significant level changes may incur additional cost.",
    "Drainage suitability of the site has not been engineered and is assumed adequate for the surface falls described in the scope of works.",
    "Paver suitability for the intended use is the client's responsibility to confirm prior to acceptance.",
    "The client is responsible for clearing furniture, fixtures and other obstructions from the work area prior to commencement.",
    describeFeatureList(
      "Known underground services",
      input.knownUndergroundServices,
      "No underground services have been identified by the client; locating and marking any underground services remains the client's responsibility.",
    ),
    `Access for this quote is based on: ${input.access}. A change in access conditions may affect price and timing.`,
    "This quote is based on visible conditions at the time of inspection. Concealed conditions such as tree roots, rubble, poor sub-grade or other obstructions discovered during excavation are excluded and may require a variation.",
    "Natural stone and concrete slab paving are excluded from this quote unless specifically listed above.",
    "Sealing of pavers is excluded from this quote unless specifically listed above.",
    ...input.exclusionsOrConditions,
    "Any change to the scope of works after acceptance will be treated as a variation and quoted separately before proceeding.",
  ];
  return conditions;
}

export type PavingOptionTotals = {
  amountIncGst: number;
  deposit: number;
  balance: number;
};

/** Derives deposit and balance from a lump-sum amount inc. GST — no per-item breakdown, unlike the standard quote calculator. */
export function calculatePavingOptionTotals(
  amountIncGst: number,
  depositPercentage: number,
): PavingOptionTotals {
  const deposit = roundMoney(amountIncGst * (depositPercentage / 100));
  const balance = roundMoney(amountIncGst - deposit);
  return { amountIncGst: roundMoney(amountIncGst), deposit, balance };
}

function buildPavingObjective(input: PavingJobInput): string {
  return `Supply and install ${input.projectTitle} for ${input.clientName} at ${input.propertyAddress}.`;
}

function buildPavingOption(option: PavingOptionInput): PavingOption {
  const totals = calculatePavingOptionTotals(option.amountIncGst, option.depositPercentage);
  return {
    name: option.name,
    description: option.description,
    areaSquareMetres: option.areaSquareMetres,
    amountIncGst: totals.amountIncGst,
    deposit: totals.deposit,
    balance: totals.balance,
  };
}

/** Assembles the full job profile: objective, scope, exclusions/conditions, and priced options. */
export function buildPavingProfile(
  input: PavingJobInput,
  options: PavingOptionInput[],
): PavingJobProfile {
  return {
    input,
    objective: buildPavingObjective(input),
    scope: buildPavingScope(input),
    exclusionsAndConditions: buildPavingConditions(input),
    options: options.map(buildPavingOption),
  };
}
