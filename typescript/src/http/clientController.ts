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
import {
  clientStillReferencedDetail,
  findClientDeletionReferences,
  type ClientReferenceKind,
} from "../clients/clientDeletionGuard.js";
import { withClientReferenceLock } from "../clients/clientReferenceLock.js";
import type { EnquiryStore } from "../enquiries/enquiry.js";
import type { InvoiceStore } from "../invoices/invoice.js";
import type { PropertyStore } from "../properties/property.js";
import type { ProjectStore } from "../projects/project.js";
import type { QuoteStore } from "../quotes/quote.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import { parseCreateClient, parseUpdateClient } from "./clientRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import {
  HTTP_CLIENT_STORE,
  HTTP_ENQUIRY_STORE,
  HTTP_INVOICE_STORE,
  HTTP_PROJECT_STORE,
  HTTP_PROPERTY_STORE,
  HTTP_QUOTE_REPOSITORY,
  HTTP_QUOTE_STORE,
} from "./tokens.js";

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

function stillReferenced(kinds: readonly ClientReferenceKind[]): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.CONFLICT,
    "client-still-referenced",
    "Client Still Referenced",
    clientStillReferencedDetail(kinds),
  );
}

function clientResponse(client: Client): { data: Client } {
  return { data: client };
}

@Controller("api/v1/clients")
export class ClientController {
  constructor(
    @Inject(HTTP_CLIENT_STORE) private readonly clients: ClientStore,
    @Inject(HTTP_ENQUIRY_STORE) private readonly enquiries: EnquiryStore,
    @Inject(HTTP_INVOICE_STORE) private readonly invoices: InvoiceStore,
    @Inject(HTTP_PROPERTY_STORE) private readonly properties: PropertyStore,
    @Inject(HTTP_PROJECT_STORE) private readonly projects: ProjectStore,
    @Inject(HTTP_QUOTE_STORE) private readonly quotes: QuoteStore,
    @Inject(HTTP_QUOTE_REPOSITORY) private readonly quoteRepository: QuoteRepository | null,
  ) {}

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
    return withClientReferenceLock(async () => {
      let existing: Client | null;
      try {
        existing = await this.clients.get(clientId);
      } catch {
        throw operationFailed();
      }
      if (!existing) throw notFound();

      let kinds: ClientReferenceKind[];
      try {
        kinds = await findClientDeletionReferences(clientId, {
          enquiries: this.enquiries,
          invoices: this.invoices,
          properties: this.properties,
          projects: this.projects,
          quotes: this.quotes,
          quoteRepository: this.quoteRepository,
        });
      } catch {
        throw operationFailed();
      }
      if (kinds.length > 0) throw stillReferenced(kinds);

      let client: Client | null;
      try {
        client = await this.clients.remove(clientId);
      } catch {
        throw operationFailed();
      }
      if (!client) throw notFound();
      return clientResponse(client);
    });
  }
}
