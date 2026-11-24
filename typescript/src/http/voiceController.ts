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
  Req,
  Res,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { ToolActionService } from "../actions/toolActions.js";
import { VOICE_COMMANDS, VOICE_PROFILES, type VoiceCommand } from "../voice/voiceCommands.js";
import { stageVoiceSafeWrite, voiceUtteranceForSession } from "../voice/voiceSafeWrite.js";
import type { VoiceSessionRegistry } from "../voice/voiceSessionRegistry.js";
import {
  dispatchConversationProposal,
  type VoiceConversationService,
} from "../voice/voiceConversation.js";
import {
  isDirectVoiceWrite,
  isVoiceUndoPhrase,
  type VoiceDirectWriter,
} from "../voice/voiceDirectWrite.js";
import type { VoiceWriteTarget } from "../voice/voiceWriteTarget.js";
import { LocalLoopbackRoute } from "./localLoopbackRoute.js";
import { JarvisProblem } from "./problemDetails.js";
import {
  parseCreateVoiceSession,
  parseSwitchVoiceProfile,
  parseVoiceUtterance,
} from "./voiceRequest.js";
import {
  HTTP_TOOL_ACTIONS,
  HTTP_VOICE_CONVERSATION,
  HTTP_VOICE_DIRECT_WRITER,
  HTTP_VOICE_REGISTRY,
  HTTP_VOICE_WRITE_TARGET,
} from "./tokens.js";

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
 *
 * Exception (owner decision, 24 Nov 2026): with a direct writer configured, a
 * wake-authorised, exactly matched dictation that adds a task, reminder or
 * errand, or marks a task or errand done, is saved at once on the voice
 * project and can be reversed with "Nolan undo". Inferred (natural-language)
 * commands, explicit request targets and every other write still stage.
 */
@Controller("api/v1/voice")
@LocalLoopbackRoute()
export class VoiceController implements OnModuleDestroy {
  constructor(
    @Inject(HTTP_VOICE_REGISTRY) private readonly registry: VoiceSessionRegistry,
    @Optional()
    @Inject(HTTP_TOOL_ACTIONS)
    private readonly toolActions?: ToolActionService | null,
    @Optional()
    @Inject(HTTP_VOICE_CONVERSATION)
    private readonly conversation?: VoiceConversationService | null,
    @Optional()
    @Inject(HTTP_VOICE_WRITE_TARGET)
    private readonly voiceTarget?: VoiceWriteTarget | null,
    @Optional()
    @Inject(HTTP_VOICE_DIRECT_WRITER)
    private readonly directWriter?: VoiceDirectWriter | null,
  ) {
    if (this.conversation) this.registry.onRemove((session) => this.conversation?.clear(session));
  }

  /** App close releases the sweep timer and drops live sessions (and their history). */
  onModuleDestroy(): void {
    this.registry.dispose();
  }

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
  async dispatch(
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    let parsed;
    try {
      parsed = parseVoiceUtterance(body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "Invalid voice utterance.");
    }
    const session = this.registry.get(sessionId);
    if (!session) throw sessionNotFound();
    // A later final utterance supersedes any conversation still in flight on this session.
    if (parsed.isFinal) this.conversation?.interrupt(session);
    const hadPending = session.pending() !== undefined || session.hasPendingClarification();
    const prepared = voiceUtteranceForSession(parsed);
    if (
      this.directWriter &&
      parsed.isFinal &&
      prepared.wakeAuthorized &&
      !hadPending &&
      isVoiceUndoPhrase(prepared.transcript)
    ) {
      const undone = await this.directWriter.undo(session);
      return {
        dispatch:
          undone.status === "undone"
            ? { decision: "undone" as const, command: undone.command, capture: undone.capture }
            : { decision: "undo-unavailable" as const, reason: undone.reason },
        pending: session.pending() ?? null,
      };
    }
    const dispatch = await session.handle({
      transcript: prepared.transcript,
      isFinal: parsed.isFinal,
      wakeAuthorized: prepared.wakeAuthorized,
      ...(prepared.alternatives ? { alternatives: prepared.alternatives } : {}),
    });
    if (
      this.conversation &&
      dispatch.decision === "unrecognized" &&
      // A refused dictation ("add a task: nolan send the quote") stays a plain
      // refusal; it is never handed to the conversational responder.
      !session.lastTurnRejectedDictation() &&
      parsed.isFinal &&
      prepared.wakeAuthorized &&
      !hadPending &&
      !session.pending() &&
      !session.hasPendingClarification()
    ) {
      const abort = new AbortController();
      const onClose = () => abort.abort();
      reply.raw.once("close", onClose);
      request.raw.once("aborted", onClose);
      try {
        const outcome = await this.conversation.respond({
          session,
          transcript: prepared.transcript,
          signal: abort.signal,
          // Re-checked before every query, extra model call and the reply: a confirmation or
          // clarification armed by a concurrent utterance ends this conversation turn.
          live: () =>
            this.registry.get(sessionId) === session &&
            session.pending() === undefined &&
            !session.hasPendingClarification(),
        });
        if (outcome.status === "proposed") {
          // NOLAN understood a free-form request as one change. Its canonical
          // sentence goes through the ordinary dictation path, so every guard,
          // record lookup and the full read-back apply and nothing is staged
          // until "Nolan confirm". A sentence the grammar refuses is reported
          // as not understood, never guessed.
          const proposed = await dispatchConversationProposal(session, outcome.utterance);
          if (!proposed) {
            return {
              dispatch: {
                decision: "conversation-unavailable" as const,
                conversationReason: "ungrounded" as const,
              },
              pending: session.pending() ?? null,
            };
          }
          return { dispatch: proposed, pending: session.pending() ?? null };
        }
        return {
          dispatch:
            outcome.status === "answered"
              ? { decision: "conversation" as const, reply: outcome.reply }
              : {
                  decision: "conversation-unavailable" as const,
                  conversationReason: outcome.reason,
                },
          pending: session.pending() ?? null,
        };
      } finally {
        reply.raw.off("close", onClose);
        request.raw.off("aborted", onClose);
      }
    }
    if (
      this.directWriter &&
      this.voiceTarget &&
      dispatch.decision === "awaiting-confirmation" &&
      dispatch.capture !== undefined &&
      dispatch.inferred !== true &&
      prepared.wakeAuthorized &&
      parsed.projectId === undefined &&
      isDirectVoiceWrite(dispatch.command)
    ) {
      const direct = await this.saveDirect(session, sessionId, dispatch.command);
      if (direct) return direct;
      return { dispatch, pending: session.pending() ?? null };
    }
    if (dispatch.decision !== "proposed") {
      return { dispatch, pending: session.pending() ?? null };
    }
    const staged = await stageVoiceSafeWrite({
      service: this.toolActions,
      sessionId,
      command: dispatch.command,
      wakeAuthorized: prepared.wakeAuthorized,
      target: this.voiceTarget ?? null,
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
      ...(parsed.expectedRevision === undefined
        ? {}
        : { expectedRevision: parsed.expectedRevision }),
      // A dictated capture is exactly what the owner heard read back and
      // confirmed; a request-body capture can never replace it.
      ...(dispatch.capture !== undefined
        ? { capture: dispatch.capture }
        : parsed.capture === undefined
          ? {}
          : { capture: parsed.capture }),
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

  private async saveDirect(
    session: NonNullable<ReturnType<VoiceSessionRegistry["get"]>>,
    sessionId: string,
    command: VoiceCommand,
  ) {
    const resolved = await (this.voiceTarget as VoiceWriteTarget).resolve();
    // Not commissioned: leave the read-back armed so the staged path still works.
    if ("reason" in resolved) return null;
    const confirmed = await session.confirmPending();
    if (confirmed.decision !== "proposed" || confirmed.capture === undefined) {
      return { dispatch: confirmed, pending: session.pending() ?? null };
    }
    const saved = await (this.directWriter as VoiceDirectWriter).write({
      session,
      sessionId,
      projectId: resolved.projectId,
      command,
      capture: confirmed.capture,
    });
    if (saved.status === "refused") {
      return {
        dispatch: {
          decision: "proposed" as const,
          command,
          capture: confirmed.capture,
          reason: saved.reason,
        },
        pending: session.pending() ?? null,
      };
    }
    return {
      dispatch: {
        decision: "saved" as const,
        command,
        capture: confirmed.capture,
        ...(saved.undoExpiresAt > 0 ? { undoExpiresAt: saved.undoExpiresAt } : {}),
      },
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
    this.conversation?.clear(session);
    session.setProfile(parsed.profile);
    // get() just resolved this session, so its expiry is defined.
    const expiresAt = this.registry.expiresAt(sessionId) ?? 0;
    return { sessionId, profile: session.profile, expiresAt };
  }
}
