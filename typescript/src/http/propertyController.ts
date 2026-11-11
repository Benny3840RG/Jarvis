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

import type { ClientStore } from "../clients/client.js";
import { withClientReferenceLock } from "../clients/clientReferenceLock.js";
import type { EnquiryStore } from "../enquiries/enquiry.js";
import type { ProjectStore } from "../projects/project.js";
import type { Property, PropertyStore } from "../properties/property.js";
import {
  findPropertyReferences,
  propertyStillReferenced,
} from "../properties/propertyReference.js";
import { parseCreateProperty, parseUpdateProperty } from "./propertyRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import {
  HTTP_CLIENT_STORE,
  HTTP_ENQUIRY_STORE,
  HTTP_PROJECT_STORE,
  HTTP_PROPERTY_STORE,
} from "./tokens.js";

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
  constructor(
    @Inject(HTTP_PROPERTY_STORE) private readonly properties: PropertyStore,
    @Inject(HTTP_CLIENT_STORE) private readonly clients: ClientStore,
    @Inject(HTTP_PROJECT_STORE) private readonly projects: ProjectStore,
    @Inject(HTTP_ENQUIRY_STORE) private readonly enquiries: EnquiryStore,
  ) {}

  /** Refuse while a job or enquiry still points at the property. */
  private async assertUnreferenced(propertyId: string): Promise<void> {
    const kinds = await findPropertyReferences(propertyId, {
      enquiries: this.enquiries,
      projects: this.projects,
    });
    if (kinds.length > 0) throw propertyStillReferenced(kinds);
  }

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
      return await withClientReferenceLock(
        async () => propertyResponse(await this.properties.add(input)),
        { clients: this.clients, clientId: input.clientId },
      );
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
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
      property = await withClientReferenceLock(
        async () => {
          // Moving a property to another client would leave its jobs and
          // enquiries pointing at a property their client no longer owns.
          if (input.clientId !== undefined) {
            const current = await this.properties.get(propertyId);
            if (!current) return null;
            if (current.clientId !== input.clientId) await this.assertUnreferenced(propertyId);
          }
          return this.properties.update(propertyId, input);
        },
        input.clientId === undefined
          ? undefined
          : { clients: this.clients, clientId: input.clientId },
      );
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
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
      property = await withClientReferenceLock(async () => {
        await this.assertUnreferenced(propertyId);
        return this.properties.remove(propertyId);
      });
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationFailed();
    }
    if (!property) throw notFound();
    return propertyResponse(property);
  }
}
