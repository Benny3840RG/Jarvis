import { applyQuoteUpdate, cloneQuote, createQuote } from "./quoteData.js";
import type { Quote, QuoteInput, QuoteStore, QuoteUpdate } from "./quote.js";

/** In-memory QuoteStore for tests and default HTTP wiring; nothing is persisted. */
export class InMemoryQuoteStore implements QuoteStore {
  private readonly quotes = new Map<string, Quote>();

  list(): Promise<Quote[]> {
    return Promise.resolve([...this.quotes.values()].map(cloneQuote));
  }

  get(id: string): Promise<Quote | null> {
    const quote = this.quotes.get(id);
    return Promise.resolve(quote ? cloneQuote(quote) : null);
  }

  add(input: QuoteInput): Promise<Quote> {
    let quote: Quote;
    try {
      quote = createQuote(input);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.quotes.set(quote.id, quote);
    return Promise.resolve(cloneQuote(quote));
  }

  update(id: string, update: QuoteUpdate): Promise<Quote | null> {
    const quote = this.quotes.get(id);
    if (!quote) return Promise.resolve(null);
    try {
      applyQuoteUpdate(quote, update);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(cloneQuote(quote));
  }

  remove(id: string): Promise<Quote | null> {
    const quote = this.quotes.get(id);
    if (!quote) return Promise.resolve(null);
    this.quotes.delete(id);
    return Promise.resolve(cloneQuote(quote));
  }
}
