import { randomUUID } from "node:crypto";

import type { Property, PropertyInput, PropertyStore, PropertyUpdate } from "./property.js";

function requiredString(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function normalizeHazards(hazards: string[] | undefined): string[] {
  if (!hazards) return [];
  return [...new Set(hazards.map((hazard) => hazard.trim()).filter(Boolean))];
}

function optionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function cloneProperty(property: Property): Property {
  return { ...property, hazards: [...property.hazards] };
}

/** In-memory PropertyStore for tests and injected HTTP wiring. */
export class InMemoryPropertyStore implements PropertyStore {
  private readonly properties = new Map<string, Property>();

  list(filter: { clientId?: string } = {}): Promise<Property[]> {
    const properties = [...this.properties.values()].filter(
      (property) => filter.clientId === undefined || property.clientId === filter.clientId,
    );
    return Promise.resolve(properties.map(cloneProperty));
  }

  get(id: string): Promise<Property | null> {
    const property = this.properties.get(id);
    return Promise.resolve(property ? cloneProperty(property) : null);
  }

  add(input: PropertyInput): Promise<Property> {
    const now = Date.now();
    const property: Property = {
      id: randomUUID(),
      clientId: requiredString(input.clientId, "Property clientId"),
      address: requiredString(input.address, "Property address"),
      hazards: normalizeHazards(input.hazards),
      ...(optionalText(input.accessNotes) === undefined
        ? {}
        : { accessNotes: optionalText(input.accessNotes) }),
      ...(optionalText(input.serviceNotes) === undefined
        ? {}
        : { serviceNotes: optionalText(input.serviceNotes) }),
      createdAt: now,
      updatedAt: now,
    };
    this.properties.set(property.id, property);
    return Promise.resolve(cloneProperty(property));
  }

  update(id: string, update: PropertyUpdate): Promise<Property | null> {
    if (
      update.clientId === undefined &&
      update.address === undefined &&
      update.hazards === undefined &&
      update.accessNotes === undefined &&
      update.serviceNotes === undefined
    ) {
      throw new Error("Property update requires at least one changed field.");
    }
    const property = this.properties.get(id);
    if (!property) return Promise.resolve(null);
    if (update.clientId !== undefined)
      property.clientId = requiredString(update.clientId, "Property clientId");
    if (update.address !== undefined)
      property.address = requiredString(update.address, "Property address");
    if (update.hazards !== undefined) property.hazards = normalizeHazards(update.hazards);
    if (update.accessNotes !== undefined) {
      const cleaned = update.accessNotes === null ? "" : update.accessNotes.trim();
      if (cleaned) property.accessNotes = cleaned;
      else delete property.accessNotes;
    }
    if (update.serviceNotes !== undefined) {
      const cleaned = update.serviceNotes === null ? "" : update.serviceNotes.trim();
      if (cleaned) property.serviceNotes = cleaned;
      else delete property.serviceNotes;
    }
    property.updatedAt = Date.now();
    return Promise.resolve(cloneProperty(property));
  }

  remove(id: string): Promise<Property | null> {
    const property = this.properties.get(id);
    if (!property) return Promise.resolve(null);
    this.properties.delete(id);
    return Promise.resolve(cloneProperty(property));
  }
}
