import assert from "node:assert/strict";
import { chmod, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dns from "node:dns/promises";
import { request, Server } from "node:http";
import { createServer as createProbeServer } from "node:net";
import { describe, it } from "node:test";
import {
  authorizeOutlookConnection,
  verifyOutlookConnection,
} from "../src/auth/outlookOnboarding.js";
import { resolveOutlookConnections } from "../src/auth/microsoftOutlookConnections.js";

// Some containers expose no IPv6 loopback, so binding `::1` fails with
// EAFNOSUPPORT before any assertion below can run. `authorizeOutlookConnection`
// treats an unbindable family as optional only when `localhost` does not
// resolve to it, so the IPv6 cases here assert real behaviour that such a host
// cannot exercise at all. Probe once so those cases narrow to what the platform
// supports instead of failing on its absence; a host with IPv6 still runs them.
const ipv6LoopbackAvailable = await new Promise<boolean>((resolve, reject) => {
  const probe = createProbeServer();
  probe.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") {
      resolve(false);
    } else {
      reject(err);
    }
  });
  probe.listen({ port: 0, host: "::1" }, () => probe.close(() => resolve(true)));
});

const CALLBACK_HOSTS = ipv6LoopbackAvailable ? ["127.0.0.1", "[::1]"] : ["127.0.0.1"];

describe("Outlook browser onboarding", () => {
  for (const callbackReceived of [false, true])
    it(`expires a stalled browser launcher with callback received: ${callbackReceived}`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "outlook-launch-timeout-"));
      const connection = resolveOutlookConnections({
        JARVIS_OUTLOOK_CONNECTIONS_JSON: JSON.stringify([
          {
            id: "personal",
            clientId: "aaaaaaaa-2222-3333-4444-555555555555",
            mailbox: "test@outlook.com",
            refreshTokenFile: join(directory, "refresh.token"),
          },
        ]),
      })[0];
      let expire!: () => void;
      const originalTimeout = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
        if (delay === 180_000) expire = callback;
        return originalTimeout(callback, delay);
      });
      let launcherReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        launcherReady = resolve;
      });
      let rejectLauncher!: (error: Error) => void;
      const launcher = new Promise<void>((_resolve, reject) => {
        rejectLauncher = reject;
      });
      let callbackUrl = "";
      let providerCalls = 0;
      const operation = authorizeOutlookConnection(connection, {
        async showAuthorizationUrl(url) {
          const auth = new URL(url);
          const callback = new URL(auth.searchParams.get("redirect_uri")!);
          callback.hostname = "127.0.0.1";
          callback.searchParams.set("state", auth.searchParams.get("state")!);
          callback.searchParams.set("code", "synthetic-code");
          callbackUrl = callback.toString();
          if (callbackReceived) assert.equal((await fetch(callback)).status, 200);
          launcherReady();
          return launcher;
        },
        fetch: async () => {
          providerCalls++;
          throw new Error("provider must not run after sign-in expiry");
        },
      });
      let settled = false;
      const observed = operation.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await ready;
        expire();
        // Listener close callbacks run before the following check phase.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, true, "sign-in expiry must release a stalled browser launcher");
        assert.match(String(await observed), /outlook-onboarding-sign-in-timeout/u);
        await assert.rejects(fetch(callbackUrl));
        assert.equal(providerCalls, 0);
        assert.deepEqual(await readdir(directory), []);
      } finally {
        // Also release the old broken implementation after its expected assertion failure.
        rejectLauncher(new Error("test launcher cleanup"));
        await observed;
        await rm(directory, { recursive: true, force: true });
      }
    });

  for (const host of ["127.0.0.1", "::1"] as const)
    it(`onboards with only ${host} available when localhost resolves to that family`, async (t) => {
      if (host === "::1" && !ipv6LoopbackAvailable) {
        // localhost is mocked to resolve to ::1 only, so the listener must
        // genuinely bind it — there is no IPv6-free path through this case.
        t.skip("no IPv6 loopback on this host");
        return;
      }
      t.mock.method(dns, "lookup", async () => [{ address: host, family: host === "::1" ? 6 : 4 }]);
      const directory = await mkdtemp(join(tmpdir(), "outlook-single-stack-"));
      const connection = resolveOutlookConnections({
        JARVIS_OUTLOOK_CONNECTIONS_JSON: JSON.stringify([
          {
            id: "personal",
            clientId: "aaaaaaaa-2222-3333-4444-555555555555",
            mailbox: "test@outlook.com",
            refreshTokenFile: join(directory, "refresh.token"),
          },
        ]),
      })[0];
      const originalListen = Server.prototype.listen;
      const attempted: string[] = [];
      t.mock.method(Server.prototype, "listen", function (this: Server, ...args: unknown[]) {
        const options = args[0] as { host: string };
        attempted.push(options.host);
        if (options.host !== host) {
          queueMicrotask(() =>
            this.emit(
              "error",
              Object.assign(new Error("synthetic unavailable family"), { code: "EADDRNOTAVAIL" }),
            ),
          );
          return this;
        }
        return Reflect.apply(originalListen, this, args) as Server;
      });
      let requests = 0;
      let callbackUrl = "";
      try {
        await authorizeOutlookConnection(connection, {
          async showAuthorizationUrl(url) {
            const auth = new URL(url);
            const callback = new URL(auth.searchParams.get("redirect_uri")!);
            assert.equal(callback.hostname, "localhost");
            callback.hostname = host === "::1" ? "[::1]" : host;
            callback.searchParams.set("state", auth.searchParams.get("state")!);
            callback.searchParams.set("code", "synthetic-code");
            callbackUrl = callback.toString();
            assert.equal((await fetch(callback)).status, 200);
          },
          fetch: async (url) => {
            requests += 1;
            return new Response(
              JSON.stringify(
                String(url).endsWith("/token")
                  ? {
                      token_type: "Bearer",
                      access_token: "synthetic-access",
                      refresh_token: "synthetic-rotated",
                      expires_in: 3600,
                      scope: "Mail.ReadWrite Mail.Send",
                    }
                  : { id: "inbox-id" },
              ),
            );
          },
        });
        assert.deepEqual(attempted, ["127.0.0.1", "::1"]);
        assert.equal(requests, 3);
        assert.equal(
          await readFile(connection.config.refreshTokenFile, "utf8"),
          "synthetic-rotated\n",
        );
        await assert.rejects(fetch(callbackUrl));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

  for (const boundary of ["group-writable", "other-writable", "wrong-owner", "private"] as const)
    it(`verifies only an owned private token directory: ${boundary}`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "outlook-verify-"));
      const tokenPath = join(directory, "refresh.token");
      const connection = resolveOutlookConnections({
        JARVIS_OUTLOOK_CONNECTIONS_JSON: JSON.stringify([
          {
            id: "personal",
            clientId: "aaaaaaaa-2222-3333-4444-555555555555",
            mailbox: "test@outlook.com",
            refreshTokenFile: tokenPath,
          },
        ]),
      })[0];
      await writeFile(tokenPath, "synthetic-initial\n", { mode: 0o600 });
      if (boundary === "group-writable") await chmod(directory, 0o770);
      if (boundary === "other-writable") await chmod(directory, 0o707);
      if (boundary === "wrong-owner") {
        const actualUid = process.getuid!();
        const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
        Object.defineProperty(process, "getuid", { ...descriptor, value: () => actualUid + 1 });
        t.after(() => Object.defineProperty(process, "getuid", descriptor));
      }
      const requests: string[] = [];
      t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
        requests.push(String(url));
        return new Response(
          JSON.stringify(
            String(url).endsWith("/token")
              ? {
                  token_type: "Bearer",
                  access_token: "synthetic-access",
                  refresh_token: "synthetic-rotated",
                  expires_in: 3600,
                  scope: "Mail.ReadWrite Mail.Send",
                }
              : { id: "inbox-id" },
          ),
        );
      });
      try {
        if (boundary === "private") {
          await verifyOutlookConnection(connection);
          assert.equal(requests.length, 2);
          assert.equal(await readFile(tokenPath, "utf8"), "synthetic-rotated\n");
        } else {
          await assert.rejects(
            verifyOutlookConnection(connection),
            /directory-must-be-private-and-owned/u,
          );
          assert.deepEqual(requests, []);
          assert.equal(await readFile(tokenPath, "utf8"), "synthetic-initial\n");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

  for (const bindError of ["EADDRINUSE", "EADDRNOTAVAIL"] as const)
    it(`closes the first listener before consent when required IPv6 bind fails: ${bindError}`, async (t) => {
      t.mock.method(dns, "lookup", async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ]);
      const directory = await mkdtemp(join(tmpdir(), "outlook-bind-"));
      const connection = resolveOutlookConnections({
        JARVIS_OUTLOOK_CONNECTIONS_JSON: JSON.stringify([
          {
            id: "personal",
            clientId: "aaaaaaaa-2222-3333-4444-555555555555",
            mailbox: "test@outlook.com",
            refreshTokenFile: join(directory, "refresh.token"),
          },
        ]),
      })[0];
      let port = 0;
      let effects = 0;
      const originalListen = Server.prototype.listen;
      t.mock.method(Server.prototype, "listen", function (this: Server, ...args: unknown[]) {
        const options = args[0] as { host?: string };
        if (options.host === "::1") {
          queueMicrotask(() =>
            this.emit(
              "error",
              Object.assign(new Error("synthetic bind failure"), { code: bindError }),
            ),
          );
          return this;
        }
        this.once("listening", () => {
          const address = this.address();
          if (address && typeof address !== "string") port = address.port;
        });
        return Reflect.apply(originalListen, this, args) as Server;
      });
      try {
        await assert.rejects(
          authorizeOutlookConnection(connection, {
            async showAuthorizationUrl() {
              effects += 1;
            },
            fetch: async () => {
              effects += 1;
              return new Response(null);
            },
          }),
          /synthetic bind failure/u,
        );
        assert.ok(port > 0);
        assert.equal(effects, 0);
        await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
        assert.deepEqual(await readdir(directory), []);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

  it("rejects unsupported ownership checks before opening consent or making requests", async (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
    Object.defineProperty(process, "getuid", { ...descriptor, value: undefined });
    t.after(() => Object.defineProperty(process, "getuid", descriptor));
    const connection = resolveOutlookConnections({
      JARVIS_OUTLOOK_CONNECTIONS_JSON: JSON.stringify([
        {
          id: "personal",
          clientId: "aaaaaaaa-2222-3333-4444-555555555555",
          mailbox: "test@outlook.com",
          refreshTokenFile: join(tmpdir(), "unused-onboarding-token"),
        },
      ]),
    })[0];
    let effects = 0;
    await assert.rejects(
      authorizeOutlookConnection(connection, {
        async showAuthorizationUrl() {
          effects += 1;
        },
        fetch: async () => {
          effects += 1;
          return new Response(null);
        },
      }),
      /outlook-onboarding-requires-posix-ownership/u,
    );
    assert.equal(effects, 0);
  });

  for (const outcome of ["success", "denied", "partial-write", "file-sync"] as const)
    it(
      outcome === "denied"
        ? "does not persist credentials for a rejected mailbox"
        : outcome === "success"
          ? "uses PKCE and both localhost address families, verifies access and persists rotation"
          : `does not publish an initial credential after ${outcome} failure`,
      async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "outlook-onboard-"));
        if (outcome === "partial-write" || outcome === "file-sync") {
          const probe = await open(join(dir, "probe"), "wx", 0o600);
          const prototype = Object.getPrototypeOf(probe) as typeof probe;
          await probe.close();
          await rm(join(dir, "probe"));
          if (outcome === "partial-write") {
            const originalWrite = prototype.writeFile;
            t.mock.method(prototype, "writeFile", async function (this: typeof probe) {
              await originalWrite.call(this, "partial-credential");
              throw new Error("synthetic disk write failure");
            });
          } else {
            t.mock.method(prototype, "sync", async () => {
              throw new Error("synthetic file sync failure");
            });
          }
        }
        const connection = resolveOutlookConnections({
          JARVIS_OUTLOOK_CONNECTIONS_JSON: JSON.stringify([
            {
              id: "personal",
              clientId: "aaaaaaaa-2222-3333-4444-555555555555",
              mailbox: "test@outlook.com",
              refreshTokenFile: join(dir, "refresh.token"),
            },
          ]),
        })[0];
        const requests: string[] = [];
        try {
          const run = authorizeOutlookConnection(connection, {
            async showAuthorizationUrl(url) {
              const auth = new URL(url);
              assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
              assert.equal(auth.searchParams.get("prompt"), "select_account");
              const callback = new URL(auth.searchParams.get("redirect_uri")!);
              const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
                const req = request(
                  { hostname: "127.0.0.1", port: callback.port, path: "http://[", method: "GET" },
                  (res) => {
                    res.resume();
                    resolve(res.statusCode);
                  },
                );
                req.once("error", reject);
                req.end();
              });
              assert.equal(malformedStatus, 400);
              callback.searchParams.set("code", "test-code");
              callback.searchParams.set("state", "wrong");
              for (const host of CALLBACK_HOSTS) {
                callback.hostname = host;
                assert.equal((await fetch(callback)).status, 400);
              }
              callback.searchParams.set("state", auth.searchParams.get("state")!);
              callback.hostname =
                outcome === "success" || !ipv6LoopbackAvailable ? "127.0.0.1" : "[::1]";
              assert.equal((await fetch(callback)).status, 200);
            },
            fetch: async (url, init) => {
              requests.push(String(url));
              if (String(url).endsWith("/token")) {
                const form = new URLSearchParams(String(init?.body));
                if (form.get("grant_type") === "authorization_code")
                  assert.ok(form.get("code_verifier"));
                return new Response(
                  JSON.stringify({
                    token_type: "Bearer",
                    access_token: "access",
                    refresh_token:
                      form.get("grant_type") === "authorization_code" ? "initial" : "rotated",
                    expires_in: 3600,
                    scope: "Mail.ReadWrite Mail.Send",
                  }),
                );
              }
              assert.equal(init?.method, "GET");
              assert.match(String(url), /users\/test%40outlook.com\/mailFolders\/inbox/u);
              return outcome === "denied"
                ? new Response(null, { status: 403 })
                : new Response(JSON.stringify({ id: "inbox-id" }));
            },
          });
          if (outcome === "denied") {
            await assert.rejects(run, /mailbox-probe-rejected-403/u);
            assert.deepEqual(await readdir(dir), []);
          } else if (outcome !== "success") {
            await assert.rejects(run, /synthetic|persist-failed/u);
            assert.deepEqual(await readdir(dir), []);
          } else {
            await run;
            assert.equal(await readFile(connection.config.refreshTokenFile, "utf8"), "rotated\n");
            assert.equal(requests.length, 3);
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
});
