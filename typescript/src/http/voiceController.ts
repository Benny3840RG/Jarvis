import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";

import { VOICE_COMMANDS, VOICE_PROFILES } from "../voice/voiceCommands.js";
import type { VoiceSessionRegistry } from "../voice/voiceSessionRegistry.js";
import { LocalLoopbackRoute } from "./localLoopbackRoute.js";
import { JarvisProblem } from "./problemDetails.js";
import {
  parseCreateVoiceSession,
  parseSwitchVoiceProfile,
  parseVoiceUtterance,
} from "./voiceRequest.js";
import { HTTP_VOICE_REGISTRY } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-voice-request",
    "Invalid Voice Request",
    detail,
  );
}

function sessionNotFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "voice-session-not-found",
    "Voice Session Not Found",
    "The voice session does not exist or has expired.",
  );
}

/**
 * The authenticated voice boundary (#567). Every route sits behind the global
 * service-token guard. The controller is stateless; the session registry owns
 * the confirmation lifecycle so a client cannot forge or replay a confirmation.
 *
 * A `propose` dispatch returns the governed tool/operation *intent* only — it
 * never stages, approves or executes a ToolAction. Staging and approval stay on
 * the existing governed `/api/v1/projects/{projectId}/tool-actions` path, which
 * alone holds the owner approval token.
 */
@Controller("api/v1/voice")
@LocalLoopbackRoute()
export class VoiceController {
  constructor(@Inject(HTTP_VOICE_REGISTRY) private readonly registry: VoiceSessionRegistry) {}

  @Get("catalog")
  catalog() {
    return { profiles: [...VOICE_PROFILES], commands: VOICE_COMMANDS };
  }

  @Post("sessions")
  @HttpCode(HttpStatus.CREATED)
  createSession(@Body() body: unknown) {
    let parsed;
    try {
      parsed = parseCreateVoiceSession(body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "Invalid voice session request.");
    }
    const created = this.registry.create(parsed.profile);
    return { sessionId: created.id, profile: created.profile, expiresAt: created.expiresAt };
  }

  @Delete("sessions/:sessionId")
  endSession(@Param("sessionId") sessionId: string) {
    if (!this.registry.end(sessionId)) throw sessionNotFound();
    return { sessionId, ended: true as const };
  }

  @Post("sessions/:sessionId/utterances")
  @HttpCode(HttpStatus.OK)
  async dispatch(@Param("sessionId") sessionId: string, @Body() body: unknown) {
    let parsed;
    try {
      parsed = parseVoiceUtterance(body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "Invalid voice utterance.");
    }
    const session = this.registry.get(sessionId);
    if (!session) throw sessionNotFound();
    const dispatch = await session.handle(parsed);
    return { dispatch, pending: session.pending() ?? null };
  }

  @Post("sessions/:sessionId/profile")
  @HttpCode(HttpStatus.OK)
  switchProfile(@Param("sessionId") sessionId: string, @Body() body: unknown) {
    let parsed;
    try {
      parsed = parseSwitchVoiceProfile(body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "Invalid profile switch.");
    }
    const session = this.registry.get(sessionId);
    if (!session) throw sessionNotFound();
    session.setProfile(parsed.profile);
    // get() just resolved this session, so its expiry is defined.
    const expiresAt = this.registry.expiresAt(sessionId) ?? 0;
    return { sessionId, profile: session.profile, expiresAt };
  }
}
