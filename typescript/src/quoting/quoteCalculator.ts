import type { QuoteData } from "./quoteTypes.js";

const GST_DIVISOR = 1.1;

export type QuoteTotals = {
  totalIncGst: number;
  totalExGst: number;
  gstComponent: number;
  deposit: number;
  balance: number;
};

export function calculateQuoteTotals(quote: QuoteData): QuoteTotals {
  const totalIncGst = quote.items.reduce((sum, item) => sum + item.amountIncGst, 0);
  const totalExGst = totalIncGst / GST_DIVISOR;
  const gstComponent = totalIncGst - totalExGst;
  const deposit = totalIncGst * (quote.depositPercentage / 100);
  const balance = totalIncGst - deposit;

  return { totalIncGst, totalExGst, gstComponent, deposit, balance };
}
