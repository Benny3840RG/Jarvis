export type QuoteItem = {
  number: number;
  description: string;
  amountIncGst: number;
};

export type QuoteClient = {
  name: string;
  propertyAddress: string;
};

export type QuoteData = {
  quoteNumber: number;
  issueDate: string;
  validDays: number;
  client: QuoteClient;
  project: string;
  items: QuoteItem[];
  depositPercentage: number;
  notes: string[];
};
