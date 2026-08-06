export class RedactionError extends Error {}

export function redactCommissioningLog(input: string, secrets: unknown[]): string;
