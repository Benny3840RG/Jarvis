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

import type { Build, BuildStore } from "../builds/build.js";
import { parseCreateBuild, parseUpdateBuild } from "./buildRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_BUILD_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-build",
    "Invalid Build",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "build-not-found",
    "Build Not Found",
    "The requested build does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "build-persistence-failed",
    "Build Operation Failed",
    "The configured build store could not complete the operation.",
  );
}

function buildResponse(build: Build): { data: Build } {
  return { data: build };
}

@Controller("api/v1/builds")
export class BuildController {
  constructor(@Inject(HTTP_BUILD_STORE) private readonly builds: BuildStore) {}

  @Get()
  async list() {
    try {
      const data = await this.builds.list();
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
        return parseCreateBuild(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The build request is invalid.");
      }
    })();
    try {
      return buildResponse(await this.builds.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":buildId")
  async get(@Param("buildId") buildId: string) {
    let build: Build | null;
    try {
      build = await this.builds.get(buildId);
    } catch {
      throw operationFailed();
    }
    if (!build) throw notFound();
    return buildResponse(build);
  }

  @Patch(":buildId")
  async update(@Param("buildId") buildId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateBuild(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The build update is invalid.");
      }
    })();
    let build: Build | null;
    try {
      build = await this.builds.update(buildId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!build) throw notFound();
    return buildResponse(build);
  }

  @Delete(":buildId")
  async remove(@Param("buildId") buildId: string) {
    let build: Build | null;
    try {
      build = await this.builds.remove(buildId);
    } catch {
      throw operationFailed();
    }
    if (!build) throw notFound();
    return buildResponse(build);
  }
}
