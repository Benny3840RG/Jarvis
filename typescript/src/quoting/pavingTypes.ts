export type PavingJobInput = {
  clientName: string;
  propertyAddress: string;
  projectTitle: string;
  fullAreaSquareMetres: number;
  courtyardSquareMetres: number;
  paverSpecification: string;
  paverColourFinish: string;
  excavationDepth: string;
  baseThickness: string;
  beddingSandThickness: string;
  access: string;
  drainageFall: string;
  retainedFeatures: string[];
  knownUndergroundServices: string[];
  exclusionsOrConditions: string[];
};

/** A pricing option before totals are calculated — the raw amount and deposit rate to price it at. */
export type PavingOptionInput = {
  name: string;
  description: string;
  areaSquareMetres: number;
  amountIncGst: number;
  depositPercentage: number;
};

export type PavingOption = {
  name: string;
  description: string;
  areaSquareMetres: number;
  amountIncGst: number;
  deposit: number;
  balance: number;
};

export type PavingJobProfile = {
  input: PavingJobInput;
  objective: string;
  scope: string[];
  exclusionsAndConditions: string[];
  options: PavingOption[];
};
