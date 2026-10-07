import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
} from "@nestjs/common";

import type { ToolActionService } from "../actions/toolActions.js";
import { VOICE_COMMANDS, VOICE_PROFILES } from "../voice/voiceCommands.js";
import { stageVoiceSafeWrite, voiceUtteranceForSession } from "../voice/voiceSafeWrite.js";
import type { VoiceSessionRegistry } from "../voice/voiceSessionRegistry.js";
import { LocalLoopbackRoute } from "./localLoopbackRoute.js";
import { JarvisProblem } from "./problemDetails.js";
import {
  parseCreateVoiceSession,
  parseSwitchVoiceProfile,
  parseVoiceUtterance,
} from "./voiceRequest.js";
import { HTTP_TOOL_ACTIONS, HTTP_VOICE_REGISTRY } from "./tokens.js";

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
 * A safe write (`tasks/create`, `reminders/create`) may call `ToolActionService.stage`
 * on the existing service. Voice never approves or executes. Consequential
 * proposals stay intent-only. Approval stays on the existing tool-action route,
 * which alone holds the owner approval token.
 */
@Controller("api/v1/voice")
@LocalLoopbackRoute()
export class VoiceController {
  constructor(
    @Inject(HTTP_VOICE_REGISTRY) private readonly registry: VoiceSessionRegistry,
    @Optional()
    @Inject(HTTP_TOOL_ACTIONS)
    private readonly toolActions?: ToolActionService | null,
  ) {}

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
    const prepared = voiceUtteranceForSession(parsed);
    const dispatch = await session.handle({
      transcript: prepared.transcript,
      isFinal: parsed.isFinal,
      ...(prepared.alternatives ? { alternatives: prepared.alternatives } : {}),
    });
    if (dispatch.decision !== "proposed") {
      return { dispatch, pending: session.pending() ?? null };
    }
    const staged = await stageVoiceSafeWrite({
      service: this.toolActions,
      sessionId,
      command: dispatch.command,
      wakeAuthorized: prepared.wakeAuthorized,
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
      ...(parsed.expectedRevision === undefined
        ? {}
        : { expectedRevision: parsed.expectedRevision }),
      ...(parsed.capture === undefined ? {} : { capture: parsed.capture }),
    });
    if (!staged) return { dispatch, pending: session.pending() ?? null };
    if ("toolActionId" in staged) {
      return {
        dispatch: { ...dispatch, toolActionId: staged.toolActionId },
        pending: session.pending() ?? null,
      };
    }
    return {
      dispatch: { ...dispatch, reason: staged.reason },
      pending: session.pending() ?? null,
    };
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
