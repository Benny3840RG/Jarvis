import { randomUUID } from "node:crypto";

/**
 * Stable old-id → new-id map for Jarvis backup restore.
 *
 * `remap` mints on first sight and returns that same id forever after.
 * `bind` records an id the destination store already assigned (builds today;
 * task and reminder rows mint through `remap` because the JSON provider
 * chooses the id). Field helpers rewrite only the keys you name. They do not
 * scan arbitrary strings.
 *
 * `translateKnown` is the assistant-state walk already used on restore: a
 * string is replaced only when it is already in the map, and only once. Keys,
 * numbers, and unknown strings stay as they are. That walk is not a licence
 * to remap every string in a business record.
 *
 * Archive v4 still writes logical business ids verbatim and does not use this
 * helper. `notesAndEvidence` is not in the archive. Convex mutations keep
 * their own copy of the known-id walk; they do not import this module.
 */
export type CreateId = () => string;

export type UuidRemapperOptions = {
  createId?: CreateId;
};

const MINT_ATTEMPTS = 8;

function assertId(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`UuidRemapper ${label} must be a non-empty string.`);
  }
}

function assertPlainRecord(
  value: unknown,
  method: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`UuidRemapper.${method} requires a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`UuidRemapper.${method} requires a plain object.`);
  }
}

export class UuidRemapper {
  private readonly forward = new Map<string, string>();
  private readonly reverse = new Set<string>();
  private readonly createId: CreateId;

  constructor(options: UuidRemapperOptions = {}) {
    this.createId = options.createId ?? randomUUID;
  }

  /** Seeds a map that must not mint. Later `remap` still can, via `createId`. */
  static fromMap(ids: ReadonlyMap<string, string>, options?: UuidRemapperOptions): UuidRemapper {
    const remapper = new UuidRemapper(options);
    for (const [oldId, newId] of ids) remapper.bind(oldId, newId);
    return remapper;
  }

  get size(): number {
    return this.forward.size;
  }

  mapping(): ReadonlyMap<string, string> {
    return new Map(this.forward);
  }

  lookup(oldId: string): string | undefined {
    return this.forward.get(oldId);
  }

  /**
   * Records a destination id chosen outside this remapper. Repeating the same
   * pair is a no-op. A second new id for the same old id, or the same new id
   * for two old ids, is refused.
   */
  bind(oldId: string, newId: string): void {
    assertId(oldId, "old id");
    assertId(newId, "new id");
    const existing = this.forward.get(oldId);
    if (existing !== undefined) {
      if (existing !== newId) {
        throw new Error(`UuidRemapper already mapped ${oldId} to ${existing}.`);
      }
      return;
    }
    if (this.reverse.has(newId)) {
      throw new Error(`UuidRemapper new id ${newId} is already assigned.`);
    }
    this.forward.set(oldId, newId);
    this.reverse.add(newId);
  }

  /** Returns the bound or previously minted id, otherwise mints one. */
  remap(oldId: string): string {
    assertId(oldId, "old id");
    const existing = this.forward.get(oldId);
    if (existing !== undefined) return existing;
    const newId = this.mint();
    this.bind(oldId, newId);
    return newId;
  }

  remapArray(ids: readonly string[]): string[] {
    if (!Array.isArray(ids)) {
      throw new Error("UuidRemapper.remapArray requires an array of ids.");
    }
    return ids.map((id, index) => {
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(`UuidRemapper.remapArray index ${index} must be a non-empty string.`);
      }
      return this.remap(id);
    });
  }

  /**
   * Shallow copy. Listed string fields are remapped. Missing fields and fields
   * not in `fields` are copied unchanged, even when their text equals an old id.
   * A listed field that is present and not a non-empty string is refused.
   */
  remapFields<T extends Record<string, unknown>>(record: T, fields: readonly string[]): T {
    assertPlainRecord(record, "remapFields");
    const copy: Record<string, unknown> = { ...record };
    for (const field of fields) {
      if (!Object.hasOwn(copy, field)) continue;
      const value = copy[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(
          `UuidRemapper cannot remap field ${field}: expected a non-empty string id.`,
        );
      }
      copy[field] = this.remap(value);
    }
    return copy as T;
  }

  /** Like `remapFields`, for fields that hold arrays of ids. */
  remapArrayFields<T extends Record<string, unknown>>(record: T, fields: readonly string[]): T {
    assertPlainRecord(record, "remapArrayFields");
    const copy: Record<string, unknown> = { ...record };
    for (const field of fields) {
      if (!Object.hasOwn(copy, field)) continue;
      const value = copy[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        throw new Error(`UuidRemapper cannot remap field ${field}: expected an array of ids.`);
      }
      copy[field] = this.remapArray(value);
    }
    return copy as T;
  }

  /**
   * Replaces string values that are already mapped. Does not mint, and does not
   * walk an id through a chain: if `a → b` and `b → c`, the value `a` becomes
   * `b`.
   */
  translateKnown(value: unknown): unknown {
    if (typeof value === "string") return this.forward.get(value) ?? value;
    if (Array.isArray(value)) return value.map((entry) => this.translateKnown(entry));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.translateKnown(entry)]),
      );
    }
    return value;
  }

  private mint(): string {
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
      const newId = this.createId();
      if (typeof newId !== "string" || newId.length === 0) {
        throw new Error("UuidRemapper createId() must return a non-empty string.");
      }
      if (!this.reverse.has(newId)) return newId;
    }
    throw new Error("UuidRemapper createId() did not produce an unused id.");
  }
}
