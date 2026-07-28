import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

const MAX_REFRESH_TOKEN_BYTES = 64 * 1024;

function storeError(code: string): Error {
  const error = new Error(code);
  error.name = "FileRefreshTokenStoreError";
  return error;
}

function validateToken(value: string): string {
  const token = value.trim();
  if (
    !token ||
    Buffer.byteLength(token, "utf8") > MAX_REFRESH_TOKEN_BYTES ||
    /[\r\n]/u.test(token)
  ) {
    throw storeError("microsoft-oauth-refresh-token-invalid");
  }
  return token;
}

function assertSecureMode(mode: number): void {
  if ((mode & 0o077) !== 0 || (mode & 0o400) === 0) {
    throw storeError("microsoft-oauth-refresh-token-permissions");
  }
}

export class FileRefreshTokenStore {
  constructor(private readonly path: string) {
    if (!isAbsolute(path)) throw storeError("microsoft-oauth-refresh-token-path-invalid");
  }

  async read(): Promise<string> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw storeError("microsoft-oauth-refresh-token-not-regular");
      assertSecureMode(metadata.mode);
      if (metadata.size < 1 || metadata.size > MAX_REFRESH_TOKEN_BYTES) {
        throw storeError("microsoft-oauth-refresh-token-invalid");
      }
      return validateToken(await handle.readFile("utf8"));
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "FileRefreshTokenStoreError") throw error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ELOOP") throw storeError("microsoft-oauth-refresh-token-not-regular");
      throw storeError("microsoft-oauth-refresh-token-unavailable");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async replace(value: string): Promise<void> {
    const token = validateToken(value);
    const directory = dirname(this.path);
    const temporary = join(directory, `.${basename(this.path)}.${randomUUID()}.tmp`);
    let handle;
    try {
      const directoryMetadata = await lstat(directory);
      if (!directoryMetadata.isDirectory() || (directoryMetadata.mode & 0o022) !== 0) {
        throw storeError("microsoft-oauth-refresh-token-directory-insecure");
      }
      const targetMetadata = await lstat(this.path);
      if (!targetMetadata.isFile()) throw storeError("microsoft-oauth-refresh-token-not-regular");
      assertSecureMode(targetMetadata.mode);

      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "FileRefreshTokenStoreError") throw error;
      throw storeError("microsoft-oauth-refresh-token-persist-failed");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
