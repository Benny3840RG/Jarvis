import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";

import type { BuildLogEntry, BuildLogStore } from "../buildLog/buildLogEntry.js";
import { parseCreateBuildLog, parseUpdateBuildLog } from "./buildLogRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_BUILD_LOG_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-build-log",
    "Invalid Build Log Entry",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "build-log-not-found",
    "Build Log Entry Not Found",
    "The requested build log entry does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "build-log-persistence-failed",
    "Build Log Operation Failed",
    "The configured build log store could not complete the operation.",
  );
}

function entryResponse(entry: BuildLogEntry): { data: BuildLogEntry } {
  return { data: entry };
}

@Controller("api/v1/build-logs")
export class BuildLogController {
  constructor(@Inject(HTTP_BUILD_LOG_STORE) private readonly entries: BuildLogStore) {}

  @Get()
  async list() {
    try {
      const data = await this.entries.list();
      return { data, count: data.length };
    } catch {
      throw operationFailed();
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const input = (() => {
      try {
        return parseCreateBuildLog(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The build log request is invalid.");
      }
    })();
    try {
      return entryResponse(await this.entries.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|requires|one of/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":entryId")
  async get(@Param("entryId") entryId: string) {
    let entry: BuildLogEntry | null;
    try {
      entry = await this.entries.get(entryId);
    } catch {
      throw operationFailed();
    }
    if (!entry) throw notFound();
    return entryResponse(entry);
  }

  @Patch(":entryId")
  async update(@Param("entryId") entryId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateBuildLog(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The build log update is invalid.");
      }
    })();
    let entry: BuildLogEntry | null;
    try {
      entry = await this.entries.update(entryId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|requires|one of/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!entry) throw notFound();
    return entryResponse(entry);
  }

  @Delete(":entryId")
  async remove(@Param("entryId") entryId: string) {
    let entry: BuildLogEntry | null;
    try {
      entry = await this.entries.remove(entryId);
    } catch {
      throw operationFailed();
    }
    if (!entry) throw notFound();
    return entryResponse(entry);
  }
}
