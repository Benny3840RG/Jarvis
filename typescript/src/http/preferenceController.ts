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

import type { Preference, PreferenceStore } from "../preferences/preference.js";
import { parseCreatePreference, parseUpdatePreference } from "./preferenceRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_PREFERENCE_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-preference",
    "Invalid Preference",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "preference-not-found",
    "Preference Not Found",
    "The requested preference does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "preference-persistence-failed",
    "Preference Operation Failed",
    "The configured preference store could not complete the operation.",
  );
}

function preferenceResponse(preference: Preference): { data: Preference } {
  return { data: preference };
}

@Controller("api/v1/preferences")
export class PreferenceController {
  constructor(@Inject(HTTP_PREFERENCE_STORE) private readonly preferences: PreferenceStore) {}

  @Get()
  async list() {
    try {
      const data = await this.preferences.list();
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
        return parseCreatePreference(body);
      } catch (error: unknown) {
        throw invalid(
          error instanceof Error ? error.message : "The preference request is invalid.",
        );
      }
    })();
    try {
      return preferenceResponse(await this.preferences.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|must not|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":preferenceId")
  async get(@Param("preferenceId") preferenceId: string) {
    let preference: Preference | null;
    try {
      preference = await this.preferences.get(preferenceId);
    } catch {
      throw operationFailed();
    }
    if (!preference) throw notFound();
    return preferenceResponse(preference);
  }

  @Patch(":preferenceId")
  async update(@Param("preferenceId") preferenceId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdatePreference(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The preference update is invalid.");
      }
    })();
    let preference: Preference | null;
    try {
      preference = await this.preferences.update(preferenceId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|must not|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!preference) throw notFound();
    return preferenceResponse(preference);
  }

  @Delete(":preferenceId")
  async remove(@Param("preferenceId") preferenceId: string) {
    let preference: Preference | null;
    try {
      preference = await this.preferences.remove(preferenceId);
    } catch {
      throw operationFailed();
    }
    if (!preference) throw notFound();
    return preferenceResponse(preference);
  }
}
