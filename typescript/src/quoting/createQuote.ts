import type { QuoteStore } from "../quotes/quote.js";
import { renderQuoteText } from "./quoteRenderer.js";
import { saveQuoteRecord } from "./quoteRecordStore.js";
import type { QuoteData, QuoteItem } from "./quoteTypes.js";

/** Minimal line-reader abstraction so the intake flow can be driven by a real terminal or a test. */
export interface QuoteIntakeIo {
  question(prompt: string): Promise<string>;
  close(): void;
}

export type QuoteIntakeWriter = (line: string) => void;

export type CreateQuoteOptions = {
  quoteNumber?: number;
  issueDate?: string;
  validDays?: number;
  depositPercentage?: number;
};

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function askRequired(
  io: QuoteIntakeIo,
  write: QuoteIntakeWriter,
  prompt: string,
): Promise<string> {
  for (;;) {
    const answer = (await io.question(prompt)).trim();
    if (answer.length > 0) return answer;
    write("Jarvis: This field can't be blank — please try again.");
  }
}

async function askAmount(io: QuoteIntakeIo, write: QuoteIntakeWriter): Promise<number> {
  for (;;) {
    const answer = (await io.question("Amount inc GST? ")).trim();
    const amount = Number(answer);
    if (Number.isFinite(amount) && amount > 0) return amount;
    write("Jarvis: Please enter a positive number, e.g. 4850.");
  }
}

async function askYesNo(
  io: QuoteIntakeIo,
  write: QuoteIntakeWriter,
  prompt: string,
): Promise<boolean> {
  for (;;) {
    const answer = (await io.question(prompt)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    write('Jarvis: Please answer "y" or "n".');
  }
}

async function collectItems(io: QuoteIntakeIo, write: QuoteIntakeWriter): Promise<QuoteItem[]> {
  const items: QuoteItem[] = [];
  while (await askYesNo(io, write, "Add a line item? (y/n) ")) {
    const description = await askRequired(io, write, "Description? ");
    const amountIncGst = await askAmount(io, write);
    items.push({ number: items.length + 1, description, amountIncGst });
  }
  return items;
}

async function collectNotes(io: QuoteIntakeIo, write: QuoteIntakeWriter): Promise<string[]> {
  if (!(await askYesNo(io, write, "Add notes? (y/n) "))) return [];

  write("Jarvis: Enter notes (one per line, blank line to finish):");
  const notes: string[] = [];
  for (;;) {
    const line = (await io.question("> ")).trim();
    if (line.length === 0) break;
    notes.push(line);
  }
  return notes;
}

/**
 * Interactively collects job details and builds a QuoteData object.
 * `options.quoteNumber` defaults to 1; callers that want it derived from
 * saved quotes should compute it themselves (see `nextQuoteRecordNumber`)
 * and pass it in.
 */
export async function collectQuoteData(
  io: QuoteIntakeIo,
  write: QuoteIntakeWriter,
  options: CreateQuoteOptions = {},
): Promise<QuoteData> {
  const name = await askRequired(io, write, "Client name? ");
  const propertyAddress = await askRequired(io, write, "Property address? ");
  const project = await askRequired(io, write, "Project title? ");
  const items = await collectItems(io, write);
  const notes = await collectNotes(io, write);

  return {
    quoteNumber: options.quoteNumber ?? 1,
    issueDate: options.issueDate ?? todayIsoDate(),
    validDays: options.validDays ?? 30,
    client: { name, propertyAddress },
    project,
    items,
    depositPercentage: options.depositPercentage ?? 30,
    notes,
  };
}

/**
 * Runs the interactive quote intake flow end-to-end, prints the rendered
 * quote, and — when a store is supplied — saves it afterward. Persistence
 * failures are reported but never hide or replace the quote already shown.
 */
export async function runCreateQuote(
  io: QuoteIntakeIo,
  write: QuoteIntakeWriter,
  options: CreateQuoteOptions = {},
  store?: QuoteStore,
): Promise<QuoteData> {
  write('Jarvis: Let\'s build a quote. Answer the prompts below (or "y"/"n" where asked).');
  try {
    const quote = await collectQuoteData(io, write, options);
    write("");
    write(renderQuoteText(quote));
    if (store) {
      try {
        await saveQuoteRecord(store, quote);
      } catch (error: unknown) {
        write(
          `Jarvis: Could not save quote #${quote.quoteNumber} (${
            error instanceof Error ? error.message : String(error)
          }). The quote above was not saved — copy it now if you need it.`,
        );
      }
    }
    return quote;
  } finally {
    io.close();
  }
}
