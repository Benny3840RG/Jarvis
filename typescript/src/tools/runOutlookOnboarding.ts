import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolveOutlookConnections } from "../auth/microsoftOutlookConnections.js";
import { authorizeOutlookConnection, verifyOutlookConnection } from "../auth/outlookOnboarding.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string" }, connection: { type: "string" } },
  });
  const operation = positionals[0];
  if (
    positionals.length !== 1 ||
    !["inspect", "connect", "verify"].includes(operation) ||
    !values.config
  ) {
    throw new Error(
      "Usage: npm run outlook -- inspect|connect|verify --config /absolute/connections.json [--connection personal|business]",
    );
  }
  const connections = resolveOutlookConnections({
    JARVIS_OUTLOOK_CONNECTIONS_JSON: await readFile(values.config, "utf8"),
  });
  if (operation === "inspect") {
    console.table(
      connections.map((connection) => ({
        connection: connection.id,
        mailbox: connection.config.mailbox,
        senderConnection: connection.senderConnection,
      })),
    );
  } else {
    const connection = connections.find((entry) => entry.id === values.connection);
    if (!connection) throw new Error("Select an exact configured connection with --connection.");
    if (operation === "connect") {
      await authorizeOutlookConnection(connection, {
        async showAuthorizationUrl(url) {
          console.log(
            `Open this URL in a browser ON THIS COMPUTER and sign into ${connection.config.mailbox}:\n${url}`,
          );
        },
      });
    } else {
      await verifyOutlookConnection(connection);
    }
    console.log(
      `Verified ${connection.id}: token refresh and mailbox access. No email was sent; runtime remains disabled.`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "outlook-onboarding-failed";
  // Provider diagnostics may contain credentials; emit only controlled errors.
  console.error(
    /^(outlook-|microsoft-oauth-|Usage:|Select an exact)/u.test(message)
      ? message
      : "outlook-onboarding-failed (check configuration, network and file permissions)",
  );
  process.exitCode = 1;
}
