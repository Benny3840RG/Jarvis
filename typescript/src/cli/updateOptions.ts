export type ParsedUpdateOptions = Record<string, string | true>;

export function parseUpdateOptions(
  input: string | undefined,
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): ParsedUpdateOptions {
  const text = input?.trim() ?? "";
  if (text.length === 0) return {};

  const allowedValues = new Set(valueFlags);
  const allowedBooleans = new Set(booleanFlags);
  const matches = [...text.matchAll(/--([a-z][a-z-]*)/gi)];
  if (matches.length === 0 || text.slice(0, matches[0].index).trim().length > 0) {
    throw new Error("Update options must use explicit --flags.");
  }

  const result: ParsedUpdateOptions = {};
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const name = match[1].toLowerCase();
    if (!allowedValues.has(name) && !allowedBooleans.has(name)) {
      throw new Error(`Unknown update option: --${name}.`);
    }
    if (name in result) throw new Error(`Duplicate update option: --${name}.`);

    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const value = text.slice(valueStart, valueEnd).trim();
    if (allowedBooleans.has(name)) {
      if (value.length > 0) throw new Error(`--${name} does not accept a value.`);
      result[name] = true;
    } else {
      if (value.length === 0) throw new Error(`--${name} requires a value.`);
      result[name] = value;
    }
  }

  return result;
}
