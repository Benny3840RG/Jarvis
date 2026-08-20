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
  Query,
} from "@nestjs/common";

import type { Property, PropertyStore } from "../properties/property.js";
import { parseCreateProperty, parseUpdateProperty } from "./propertyRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_PROPERTY_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-property",
    "Invalid Property",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "property-not-found",
    "Property Not Found",
    "The requested property does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "property-persistence-failed",
    "Property Operation Failed",
    "The configured property store could not complete the operation.",
  );
}

function propertyResponse(property: Property): { data: Property } {
  return { data: property };
}

@Controller("api/v1/properties")
export class PropertyController {
  constructor(@Inject(HTTP_PROPERTY_STORE) private readonly properties: PropertyStore) {}

  @Get()
  async list(@Query("clientId") clientId?: string) {
    try {
      const data = await this.properties.list(
        typeof clientId === "string" && clientId.trim() ? { clientId: clientId.trim() } : {},
      );
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
        return parseCreateProperty(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The property request is invalid.");
      }
    })();
    try {
      return propertyResponse(await this.properties.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|must not|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":propertyId")
  async get(@Param("propertyId") propertyId: string) {
    let property: Property | null;
    try {
      property = await this.properties.get(propertyId);
    } catch {
      throw operationFailed();
    }
    if (!property) throw notFound();
    return propertyResponse(property);
  }

  @Patch(":propertyId")
  async update(@Param("propertyId") propertyId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateProperty(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The property update is invalid.");
      }
    })();
    let property: Property | null;
    try {
      property = await this.properties.update(propertyId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|must not|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!property) throw notFound();
    return propertyResponse(property);
  }

  @Delete(":propertyId")
  async remove(@Param("propertyId") propertyId: string) {
    let property: Property | null;
    try {
      property = await this.properties.remove(propertyId);
    } catch {
      throw operationFailed();
    }
    if (!property) throw notFound();
    return propertyResponse(property);
  }
}
