import { randomUUID } from "node:crypto";

import type { Project, ProjectInput, ProjectStore, ProjectUpdate } from "./project.js";

function requiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function optionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function cloneProject(project: Project): Project {
  return { ...project };
}

/** In-memory ProjectStore for tests and default HTTP wiring; nothing is persisted. */
export class InMemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, Project>();

  list(): Promise<Project[]> {
    return Promise.resolve([...this.projects.values()].map(cloneProject));
  }

  get(id: string): Promise<Project | null> {
    const project = this.projects.get(id);
    return Promise.resolve(project ? cloneProject(project) : null);
  }

  add(input: ProjectInput): Promise<Project> {
    let project: Project;
    try {
      const now = Date.now();
      project = {
        id: randomUUID(),
        clientId: requiredText(input.clientId, "Project clientId"),
        ...(optionalText(input.propertyId) === undefined
          ? {}
          : { propertyId: optionalText(input.propertyId) }),
        title: requiredText(input.title, "Project title"),
        status: input.status ?? "lead",
        ...(input.notes && input.notes.trim() ? { notes: input.notes.trim() } : {}),
        createdAt: now,
        updatedAt: now,
      };
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.projects.set(project.id, project);
    return Promise.resolve(cloneProject(project));
  }

  update(id: string, update: ProjectUpdate): Promise<Project | null> {
    try {
      if (
        update.clientId === undefined &&
        update.propertyId === undefined &&
        update.title === undefined &&
        update.status === undefined &&
        update.notes === undefined
      ) {
        throw new Error(
          "Project update requires a clientId, propertyId, title, status, or notes change.",
        );
      }
      const project = this.projects.get(id);
      if (!project) return Promise.resolve(null);
      if (update.clientId !== undefined)
        project.clientId = requiredText(update.clientId, "Project clientId");
      if (update.propertyId !== undefined) {
        const cleaned = update.propertyId === null ? "" : update.propertyId.trim();
        if (cleaned) project.propertyId = cleaned;
        else delete project.propertyId;
      }
      if (update.title !== undefined) project.title = requiredText(update.title, "Project title");
      if (update.status !== undefined) project.status = update.status;
      if (update.notes !== undefined) {
        const cleaned = update.notes === null ? "" : update.notes.trim();
        if (cleaned) project.notes = cleaned;
        else delete project.notes;
      }
      project.updatedAt = Date.now();
      return Promise.resolve(cloneProject(project));
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  remove(id: string): Promise<Project | null> {
    const project = this.projects.get(id);
    if (!project) return Promise.resolve(null);
    this.projects.delete(id);
    return Promise.resolve(cloneProject(project));
  }
}
