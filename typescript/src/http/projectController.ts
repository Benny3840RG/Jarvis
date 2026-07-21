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

import type { Project, ProjectStore } from "../projects/project.js";
import { JarvisProblem } from "./problemDetails.js";
import { parseCreateProject, parseUpdateProject } from "./projectRequest.js";
import { HTTP_PROJECT_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-project",
    "Invalid Project",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "project-not-found",
    "Project Not Found",
    "The requested project does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "project-persistence-failed",
    "Project Operation Failed",
    "The configured project store could not complete the operation.",
  );
}

function projectResponse(project: Project): { data: Project } {
  return { data: project };
}

@Controller("api/v1/projects")
export class ProjectController {
  constructor(@Inject(HTTP_PROJECT_STORE) private readonly projects: ProjectStore) {}

  @Get()
  async list() {
    try {
      const data = await this.projects.list();
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
        return parseCreateProject(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The project request is invalid.");
      }
    })();
    try {
      return projectResponse(await this.projects.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|status must/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":projectId")
  async get(@Param("projectId") projectId: string) {
    let project: Project | null;
    try {
      project = await this.projects.get(projectId);
    } catch {
      throw operationFailed();
    }
    if (!project) throw notFound();
    return projectResponse(project);
  }

  @Patch(":projectId")
  async update(@Param("projectId") projectId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateProject(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The project update is invalid.");
      }
    })();
    let project: Project | null;
    try {
      project = await this.projects.update(projectId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|requires|status must/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!project) throw notFound();
    return projectResponse(project);
  }

  @Delete(":projectId")
  async remove(@Param("projectId") projectId: string) {
    let project: Project | null;
    try {
      project = await this.projects.remove(projectId);
    } catch {
      throw operationFailed();
    }
    if (!project) throw notFound();
    return projectResponse(project);
  }
}
