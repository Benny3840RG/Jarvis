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

import type { Asset, AssetStore } from "../assets/asset.js";
import { deriveAssetView, type AssetView } from "../assets/assetView.js";
import { parseCreateAsset, parseUpdateAsset } from "./assetRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_ASSET_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-asset",
    "Invalid Asset",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "asset-not-found",
    "Asset Not Found",
    "The requested asset does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "asset-persistence-failed",
    "Asset Operation Failed",
    "The configured asset store could not complete the operation.",
  );
}

function assetResponse(asset: Asset): { data: AssetView } {
  return { data: deriveAssetView(asset) };
}

@Controller("api/v1/assets")
export class AssetController {
  constructor(@Inject(HTTP_ASSET_STORE) private readonly assets: AssetStore) {}

  @Get()
  async list() {
    try {
      const data = (await this.assets.list()).map((asset) => deriveAssetView(asset));
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
        return parseCreateAsset(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The asset request is invalid.");
      }
    })();
    try {
      return assetResponse(await this.assets.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|must not|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":assetId")
  async get(@Param("assetId") assetId: string) {
    let asset: Asset | null;
    try {
      asset = await this.assets.get(assetId);
    } catch {
      throw operationFailed();
    }
    if (!asset) throw notFound();
    return assetResponse(asset);
  }

  @Patch(":assetId")
  async update(@Param("assetId") assetId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateAsset(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The asset update is invalid.");
      }
    })();
    let asset: Asset | null;
    try {
      asset = await this.assets.update(assetId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|must not|requires/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!asset) throw notFound();
    return assetResponse(asset);
  }

  @Delete(":assetId")
  async remove(@Param("assetId") assetId: string) {
    let asset: Asset | null;
    try {
      asset = await this.assets.remove(assetId);
    } catch {
      throw operationFailed();
    }
    if (!asset) throw notFound();
    return assetResponse(asset);
  }
}
