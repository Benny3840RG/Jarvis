/**
 * Personal Microsoft accounts (consumers authority, no tenant) are addressed
 * as the signed-in user. Work or school mailboxes stay on `/users/{mailbox}`.
 * Microsoft Graph documents `/me` for the delegated personal account and does
 * not support listing or addressing that account through the directory.
 */

export type GraphMailboxAddressing = "signed-in" | "users";

export function graphMailboxAddressing(tokenEndpoint: string): GraphMailboxAddressing {
  try {
    const url = new URL(tokenEndpoint);
    return url.protocol === "https:" &&
      url.hostname === "login.microsoftonline.com" &&
      url.pathname.startsWith("/consumers/")
      ? "signed-in"
      : "users";
  } catch {
    return "users";
  }
}

export function graphMailboxPrefix(addressing: GraphMailboxAddressing, mailbox: string): string {
  return addressing === "signed-in" ? "me" : `users/${encodeURIComponent(mailbox)}`;
}

/**
 * True when every non-empty mail and userPrincipalName equals the configured
 * mailbox. A blank profile matches nothing.
 */
export function signedInMailboxMatches(body: unknown, configuredMailbox: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  const expected = configuredMailbox.trim().toLowerCase();
  if (expected.length === 0) return false;
  const present = [record.mail, record.userPrincipalName].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (present.length === 0) return false;
  return present.every((value) => value.trim().toLowerCase() === expected);
}

export type SignedInProfileRead = { ok: true; body: unknown } | { ok: false };

/** Reads the signed-in profile. A failed read is unreadable, not a match. */
export async function readSignedInProfile(input: {
  origin: string;
  token: string;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
}): Promise<SignedInProfileRead> {
  let response: Response;
  try {
    response = await input.fetch(`${input.origin}/me?$select=mail,userPrincipalName`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
      },
      redirect: "error",
      signal: input.signal,
    });
  } catch {
    return { ok: false };
  }
  if (response.status !== 200) return { ok: false };
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false };
  }
}
