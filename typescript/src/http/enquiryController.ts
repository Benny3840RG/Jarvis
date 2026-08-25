import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";

import type { Enquiry, EnquiryConversionResult, EnquiryStore } from "../enquiries/enquiry.js";
import type { ProjectStore } from "../projects/project.js";
import {
  parseCloseEnquiry,
  parseConvertEnquiry,
  parseCreateEnquiry,
  parseEnquiryStatus,
  parseUpdateEnquiry,
} from "./enquiryRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_ENQUIRY_STORE, HTTP_PROJECT_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-enquiry",
    "Invalid Enquiry",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "enquiry-not-found",
    "Enquiry Not Found",
    "The requested enquiry does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "enquiry-persistence-failed",
    "Enquiry Operation Failed",
    "The configured enquiry store could not complete the operation.",
  );
}

function enquiryResponse(enquiry: Enquiry): { data: Enquiry } {
  return { data: enquiry };
}

@Controller("api/v1/enquiries")
export class EnquiryController {
  constructor(
    @Inject(HTTP_ENQUIRY_STORE) private readonly enquiries: EnquiryStore,
    @Inject(HTTP_PROJECT_STORE) private readonly projects: ProjectStore,
  ) {}

  @Get()
  async list(@Query("status") status?: string, @Query("clientId") clientId?: string) {
    const parsedStatus = (() => {
      try {
        return parseEnquiryStatus(status);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The enquiry filter is invalid.");
      }
    })();
    try {
      const data = await this.enquiries.list({
        ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
        ...(typeof clientId === "string" && clientId.trim() ? { clientId: clientId.trim() } : {}),
      });
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
        return parseCreateEnquiry(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The enquiry request is invalid.");
      }
    })();
    try {
      return enquiryResponse(await this.enquiries.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|must not|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":enquiryId")
  async get(@Param("enquiryId") enquiryId: string) {
    let enquiry: Enquiry | null;
    try {
      enquiry = await this.enquiries.get(enquiryId);
    } catch {
      throw operationFailed();
    }
    if (!enquiry) throw notFound();
    return enquiryResponse(enquiry);
  }

  @Patch(":enquiryId")
  async update(@Param("enquiryId") enquiryId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateEnquiry(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The enquiry update is invalid.");
      }
    })();
    let enquiry: Enquiry | null;
    try {
      enquiry = await this.enquiries.update(enquiryId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /open|empty|requires|must be|must not/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!enquiry) throw notFound();
    return enquiryResponse(enquiry);
  }

  @Post(":enquiryId/close")
  async close(@Param("enquiryId") enquiryId: string, @Body() body: unknown) {
    const reason = (() => {
      try {
        return parseCloseEnquiry(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The close request is invalid.");
      }
    })();
    let enquiry: Enquiry | null;
    try {
      enquiry = await this.enquiries.close(enquiryId, reason);
    } catch (error: unknown) {
      if (error instanceof Error && /open|empty/.test(error.message)) throw invalid(error.message);
      throw operationFailed();
    }
    if (!enquiry) throw notFound();
    return enquiryResponse(enquiry);
  }

  @Post(":enquiryId/convert-project")
  async convert(@Param("enquiryId") enquiryId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseConvertEnquiry(body);
      } catch (error: unknown) {
        throw invalid(
          error instanceof Error ? error.message : "The conversion request is invalid.",
        );
      }
    })();
    let result: EnquiryConversionResult | null;
    try {
      result = await this.enquiries.convertToProject(enquiryId, this.projects, input);
    } catch (error: unknown) {
      if (error instanceof Error && /open|unavailable|empty/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!result) throw notFound();
    return { data: result };
  }
}
