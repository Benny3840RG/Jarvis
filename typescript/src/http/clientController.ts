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

import type { Client, ClientStore } from "../clients/client.js";
import { parseCreateClient, parseUpdateClient } from "./clientRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_CLIENT_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-client",
    "Invalid Client",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "client-not-found",
    "Client Not Found",
    "The requested client does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "client-persistence-failed",
    "Client Operation Failed",
    "The configured client store could not complete the operation.",
  );
}

function clientResponse(client: Client): { data: Client } {
  return { data: client };
}

@Controller("api/v1/clients")
export class ClientController {
  constructor(@Inject(HTTP_CLIENT_STORE) private readonly clients: ClientStore) {}

  @Get()
  async list() {
    try {
      const data = await this.clients.list();
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
        return parseCreateClient(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The client request is invalid.");
      }
    })();
    try {
      return clientResponse(await this.clients.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty/.test(error.message)) throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":clientId")
  async get(@Param("clientId") clientId: string) {
    let client: Client | null;
    try {
      client = await this.clients.get(clientId);
    } catch {
      throw operationFailed();
    }
    if (!client) throw notFound();
    return clientResponse(client);
  }

  @Patch(":clientId")
  async update(@Param("clientId") clientId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateClient(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The client update is invalid.");
      }
    })();
    let client: Client | null;
    try {
      client = await this.clients.update(clientId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!client) throw notFound();
    return clientResponse(client);
  }

  @Delete(":clientId")
  async remove(@Param("clientId") clientId: string) {
    let client: Client | null;
    try {
      client = await this.clients.remove(clientId);
    } catch {
      throw operationFailed();
    }
    if (!client) throw notFound();
    return clientResponse(client);
  }
}
