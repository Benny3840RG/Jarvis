export class RedactionError extends Error {}

export function redactCommissioningLog(input: string, secrets: unknown[]): string;
export function secretValuesFromEnvironment(env?: Record<string, string | undefined>): string[];
