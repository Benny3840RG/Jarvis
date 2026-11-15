/**
 * NOLAN voice — the dedicated project that voice safe writes stage against.
 *
 * A HUD microphone turn carries no project or revision, so before this module
 * a confirmed "Nolan, add a task: …" could only report "not commissioned". The
 * owner chose a single dedicated voice project (owner decision on #815): the
 * server resolves that project's key and its *current* revision at confirm
 * time, so no client ever has to know or forge either.
 *
 * Safety contract:
 *   - Resolution only reads. It never creates or bumps the project; that is the
 *     one-time owner commissioning step (`npm run commission:voice-project`).
 *   - A missing project, an unreadable store, or a malformed revision fails
 *     closed with an honest reason. Nothing is staged.
 *   - The resolved target only feeds `ToolActionService.stage`. Owner approval
 *     and execution are unchanged; voice never approves or executes.
 */

import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";

export const VOICE_PROJECT_KEY_ENV = "JARVIS_VOICE_PROJECT_KEY";
export const DEFAULT_VOICE_PROJECT_KEY = "nolan-voice";
export const VOICE_PROJECT_NAME = "NOLAN voice capture";

const PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type VoiceProjectTarget = { projectId: string; expectedRevision: number };

/** Reads a project's current revision; `null` when the project does not exist. */
export interface VoiceProjectRevisionReader {
  revision(projectKey: string): Promise<number | null>;
}

export function voiceProjectNotCommissionedReason(projectKey: string): string {
  return `Safe write was not staged: the voice project "${projectKey}" is not commissioned. Run npm run commission:voice-project.`;
}

export const VOICE_PROJECT_UNREADABLE_REASON =
  "Safe write was not staged: the voice project could not be read.";

export function resolveVoiceProjectKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment[VOICE_PROJECT_KEY_ENV]?.trim();
  if (!configured) return DEFAULT_VOICE_PROJECT_KEY;
  if (!PROJECT_KEY_PATTERN.test(configured)) {
    throw new Error(
      `${VOICE_PROJECT_KEY_ENV} must be a lowercase token (letters, digits, ".", "_", "-"; max 64).`,
    );
  }
  return configured;
}

export class VoiceWriteTarget {
  constructor(
    readonly projectKey: string,
    private readonly reader: VoiceProjectRevisionReader,
  ) {
    if (!PROJECT_KEY_PATTERN.test(projectKey)) {
      throw new Error("Voice project key must be a lowercase token.");
    }
  }

  /** The project and its current revision, or the reason nothing can be staged. */
  async resolve(): Promise<VoiceProjectTarget | { reason: string }> {
    let revision: number | null;
    try {
      revision = await this.reader.revision(this.projectKey);
    } catch {
      return { reason: VOICE_PROJECT_UNREADABLE_REASON };
    }
    if (revision === null) {
      return { reason: voiceProjectNotCommissionedReason(this.projectKey) };
    }
    if (!Number.isInteger(revision) || revision < 1) {
      return { reason: VOICE_PROJECT_UNREADABLE_REASON };
    }
    return { projectId: this.projectKey, expectedRevision: revision };
  }
}

type ConvexQueryClient = Pick<ConvexHttpClient, "query">;

export class ConvexVoiceProjectRevisionReader implements VoiceProjectRevisionReader {
  constructor(
    private readonly client: ConvexQueryClient,
    private readonly serviceToken: string,
  ) {}

  async revision(projectKey: string): Promise<number | null> {
    const project = await this.client.query(api.projects.get, {
      serviceToken: this.serviceToken,
      projectKey,
    });
    return project === null ? null : project.revision;
  }
}

/**
 * The configured voice target for the running server, or `null` when tool
 * actions are not backed by Convex (in which case nothing could be staged).
 */
export function createVoiceWriteTargetFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): VoiceWriteTarget | null {
  if (resolvePersistenceProviderName(environment.PERSISTENCE_PROVIDER) !== "convex") return null;
  const convexUrl = environment.CONVEX_URL?.trim();
  const serviceToken = environment.JARVIS_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) return null;
  return new VoiceWriteTarget(
    resolveVoiceProjectKey(environment),
    new ConvexVoiceProjectRevisionReader(new ConvexHttpClient(convexUrl), serviceToken),
  );
}
