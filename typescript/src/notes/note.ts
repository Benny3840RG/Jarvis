export const NOTE_DOMAINS = ["business", "home", "workshop", "shared"] as const;
export type NoteDomain = (typeof NOTE_DOMAINS)[number];

export const NOTE_SENSITIVITIES = ["internal", "private", "secret"] as const;
export type NoteSensitivity = (typeof NOTE_SENSITIVITIES)[number];

export const NOTE_RETENTIONS = ["ephemeral", "standard", "long_term"] as const;
export type NoteRetention = (typeof NOTE_RETENTIONS)[number];

export type NoteRecord = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  tags: string[];
  domain: NoteDomain;
  sensitivity: NoteSensitivity;
  retention: NoteRetention;
  sourceRequestId: string;
  correlationId: string;
  source: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type CreateNoteInput = {
  projectId: string;
  title: string;
  body: string;
  tags: string[];
  domain: NoteDomain;
  sensitivity: NoteSensitivity;
  retention: NoteRetention;
  idempotencyKey: string;
  actionFingerprint: string;
  sourceRequestId: string;
  correlationId: string;
  source: string;
};

export interface NoteStore {
  create(input: CreateNoteInput): Promise<NoteRecord>;
  get(projectId: string, id: string): Promise<NoteRecord | null>;
  list(projectId: string, limit?: number): Promise<NoteRecord[]>;
  remove(projectId: string, id: string): Promise<NoteRecord | null>;
}
