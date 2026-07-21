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

import type { Errand, ErrandStore } from "../errands/errand.js";
import { parseCreateErrand, parseUpdateErrand } from "./errandRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_ERRAND_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-errand",
    "Invalid Errand",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "errand-not-found",
    "Errand Not Found",
    "The requested errand does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "errand-persistence-failed",
    "Errand Operation Failed",
    "The configured errand store could not complete the operation.",
  );
}

function errandResponse(errand: Errand): { data: Errand } {
  return { data: errand };
}

@Controller("api/v1/errands")
export class ErrandController {
  constructor(@Inject(HTTP_ERRAND_STORE) private readonly errands: ErrandStore) {}

  @Get()
  async list() {
    try {
      const data = await this.errands.list();
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
        return parseCreateErrand(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The errand request is invalid.");
      }
    })();
    try {
      return errandResponse(await this.errands.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":errandId")
  async get(@Param("errandId") errandId: string) {
    let errand: Errand | null;
    try {
      errand = await this.errands.get(errandId);
    } catch {
      throw operationFailed();
    }
    if (!errand) throw notFound();
    return errandResponse(errand);
  }

  @Patch(":errandId")
  async update(@Param("errandId") errandId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateErrand(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The errand update is invalid.");
      }
    })();
    let errand: Errand | null;
    try {
      errand = await this.errands.update(errandId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!errand) throw notFound();
    return errandResponse(errand);
  }

  @Delete(":errandId")
  async remove(@Param("errandId") errandId: string) {
    let errand: Errand | null;
    try {
      errand = await this.errands.remove(errandId);
    } catch {
      throw operationFailed();
    }
    if (!errand) throw notFound();
    return errandResponse(errand);
  }
}
