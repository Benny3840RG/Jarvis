import { calculateQuoteTotals } from "./quoteCalculator.js";
import type { QuoteData } from "./quoteTypes.js";

const BUSINESS_NAME = "THE BEEZ TREEZ PROPERTY SOLUTIONS";
const BUSINESS_ABN = "14 796 994 912";
const BUSINESS_PHONE = "0413 926 324";
const BUSINESS_EMAIL = "TheBeezTreez@outlook.com";
const BANK_BSB = "313-140";
const BANK_ACCOUNT = "12553206";
const BANK_PAYID = "0413 926 324";

export function formatCurrency(amount: number): string {
  return amount.toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
  });
}

function formatIssueDate(issueDate: string): string {
  const date = new Date(`${issueDate}T00:00:00`);
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}

export function renderQuoteText(quote: QuoteData): string {
  const totals = calculateQuoteTotals(quote);
  const lines: string[] = [];

  lines.push(BUSINESS_NAME);
  lines.push(`ABN ${BUSINESS_ABN}`);
  lines.push(`Phone: ${BUSINESS_PHONE}  |  Email: ${BUSINESS_EMAIL}`);
  lines.push("");
  lines.push(`QUOTE #${quote.quoteNumber}`);
  lines.push(`Issue Date: ${formatIssueDate(quote.issueDate)}`);
  lines.push(`Valid For: ${quote.validDays} days from issue date`);
  lines.push("");
  lines.push(`Client: ${quote.client.name}`);
  lines.push(`Property Address: ${quote.client.propertyAddress}`);
  lines.push("");
  lines.push(`Project: ${quote.project}`);
  lines.push("");
  lines.push("ITEMS");
  for (const item of quote.items) {
    lines.push(`${item.number}. ${item.description}`);
    lines.push(`   ${formatCurrency(item.amountIncGst)}`);
  }
  lines.push("");
  lines.push(`Total Quoted Price (inc. GST): ${formatCurrency(totals.totalIncGst)}`);
  lines.push(`GST Component: ${formatCurrency(totals.gstComponent)}`);
  lines.push(`Deposit (${quote.depositPercentage}%): ${formatCurrency(totals.deposit)}`);
  lines.push(`Balance Due on Completion: ${formatCurrency(totals.balance)}`);
  lines.push("");
  lines.push("PAYMENT & ACCEPTANCE");
  lines.push(
    `A ${quote.depositPercentage}% deposit is required to confirm booking, with the balance due on completion.`,
  );
  lines.push(`BSB: ${BANK_BSB}`);
  lines.push(`Account: ${BANK_ACCOUNT}`);
  lines.push(`PayID: ${BANK_PAYID}`);
  lines.push(
    "Acceptance of this quote (by payment of deposit or written confirmation) constitutes agreement to the terms above.",
  );
  lines.push("");
  lines.push("NOTES");
  for (const note of quote.notes) {
    lines.push(`- ${note}`);
  }

  return lines.join("\n");
}
