import path from "node:path";
const UNIT_BYTES = 96 * 1024;
const MAX_JSON_CONTEXT_TARGETS = 128;
const size = (text) => Buffer.byteLength(JSON.stringify(text));
const pointer = (key) => key.replaceAll("~", "~0").replaceAll("/", "~1");

// Parse positions only. Source text (including whitespace) is never rewritten.
function jsonSpans(text, includeContainers = false) {
  JSON.parse(text);
  let at = 0;
  const whitespace = () => {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
  };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      if (text[at++] === '"') break;
      if (text[at - 1] === "\\") at++;
    }
    return JSON.parse(text.slice(start, at));
  };
  const value = (location) => {
    whitespace();
    const start = at,
      children = [];
    if (text[at] === "{") {
      at++;
      whitespace();
      while (text[at] !== "}") {
        const propertyStart = at;
        const key = string();
        whitespace();
        at++;
        const child = value(`${location}/${pointer(key)}`);
        children.push({ ...child, start: propertyStart });
        whitespace();
        if (text[at] !== ",") break;
        at++;
        whitespace();
      }
      at++;
    } else if (text[at] === "[") {
      at++;
      whitespace();
      while (text[at] !== "]") {
        value(location);
        whitespace();
        if (text[at] !== ",") break;
        at++;
        whitespace();
      }
      at++;
    } else if (text[at] === '"') string();
    else while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
    return { start, end: at, location, children };
  };
  const root = value("");
  const leaves = [],
    containers = [];
  const walk = (node) => {
    if (
      node.children.length &&
      (node.location === "" ||
        node.location === "/paths" ||
        node.location === "/packages" ||
        node.location === "/components" ||
        /^\/components\/[^/]+$/.test(node.location))
    ) {
      containers.push({
        start: node.start,
        end: node.end,
        label: node.location,
      });
      node.children.forEach(walk);
    } else leaves.push(node);
  };
  walk(root);
  let end = 0;
  const spans = [];
  for (const leaf of leaves) {
    if (leaf.start > end)
      spans.push({
        start: end,
        end: leaf.start,
        label: `structure:${leaf.location}`,
      });
    spans.push({ start: leaf.start, end: leaf.end, label: leaf.location });
    end = leaf.end;
  }
  if (end < text.length)
    spans.push({ start: end, end: text.length, label: "structure:end" });
  return includeContainers ? [...spans, ...containers] : spans;
}
function part(text, fileIndex, side, start, end) {
  return {
    text: text.slice(start, end),
    references: [
      {
        fileIndex,
        side,
        start: Buffer.byteLength(text.slice(0, start)),
        end: Buffer.byteLength(text.slice(0, end)),
        lineStart: text.slice(0, start).split("\n").length,
      },
    ],
  };
}
function pair(before, after, label) {
  const parts =
    before && after && before.text === after.text
      ? [
          {
            text: before.text,
            references: [...before.references, ...after.references],
          },
        ]
      : [before, after].filter(Boolean);
  return { label, parts };
}
export function pairedUnits(files) {
  const units = [];
  for (const [fileIndex, file] of files.entries()) {
    const { before, after } = file;
    const whole = pair(
      before === null
        ? null
        : part(before, fileIndex, "before", 0, before.length),
      after === null ? null : part(after, fileIndex, "after", 0, after.length),
      file.filename,
    );
    if (
      whole.parts.reduce((n, p) => n + size(p.text), 0) <=
      (before === after ||
      before === null ||
      after === null ||
      file.filename.endsWith(".json")
        ? UNIT_BYTES
        : 8 * 1024)
    ) {
      units.push(whole);
      continue;
    }
    let semantic = file.filename.endsWith(".json");
    try {
      if (semantic)
        for (const source of [before, after])
          if (source !== null) JSON.parse(source);
    } catch {
      semantic = false;
    }
    if (semantic) {
      const sides = {};
      for (const side of ["before", "after"]) {
        const text = file[side];
        sides[side] = new Map(
          text === null
            ? []
            : jsonSpans(text).map((s) => [
                s.label,
                part(text, fileIndex, side, s.start, s.end),
              ]),
        );
      }
      for (const label of new Set([
        ...sides.before.keys(),
        ...sides.after.keys(),
      ]))
        units.push(
          pair(sides.before.get(label), sides.after.get(label), label),
        );
      continue;
    }
    units.push(...lineUnits(file, fileIndex));
  }
  return units;
}
// Bounded lexical hints for static imports and literal typed Convex references. Dynamic import,
// require, aliases and comment-separated syntax are not resolved. No source is fetched.
export function changedImportContext(files, fileIndices) {
  const wanted = new Set();
  const includeBackend = (moduleName) => {
    const suffix = `convex/${moduleName}.ts`;
    const targets = files
      .map((file, fileIndex) => ({ file, fileIndex }))
      .filter(
        ({ file }) =>
          file.filename === suffix || file.filename.endsWith(`/${suffix}`),
      );
    if (targets.length === 1 && !fileIndices.has(targets[0].fileIndex))
      wanted.add(targets[0].fileIndex);
  };
  for (const index of fileIndices)
    for (const text of [files[index].before, files[index].after]) {
      for (const match of (text ?? "").matchAll(
        /\b(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g,
      )) {
        const resolved = path.posix
          .normalize(
            path.posix.join(
              path.posix.dirname(files[index].filename),
              match[1],
            ),
          )
          .replace(/\.js$/, ".ts");
        const found = files.findIndex((f) => f.filename === resolved);
        if (found >= 0 && !fileIndices.has(found)) wanted.add(found);
      }
      // Typed Convex function references name a backend module rather than an
      // import. Resolve only a unique module in the already fetched inventory.
      for (const match of (text ?? "").matchAll(
        /\bmakeFunctionReference(?:<[^>\n]{1,256}>)?\(\s*["']([A-Za-z0-9_/-]+):[A-Za-z0-9_]+["']/g,
      )) {
        includeBackend(match[1]);
      }
      const generatedApiImport = [
        ...(text ?? "").matchAll(
          /\bimport\s*{([^}]{0,2048})}\s*from\s*["'][^"']*\/_generated\/api\.js["']/g,
        ),
      ].some((match) =>
        match[1].split(",").some((name) => name.trim() === "api"),
      );
      if (generatedApiImport) {
        for (const match of (text ?? "").matchAll(/\bapi\.([A-Za-z0-9_]+)\b/g))
          includeBackend(match[1]);
      }
    }
  return [...wanted].sort((a, b) => a - b);
}

function lineUnits(file, fileIndex) {
  const before = file.before ?? "",
    after = file.after ?? "";
  const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = lines(before),
    b = lines(after);
  const unique = (items) => {
    const map = new Map();
    items.forEach((line, index) => map.set(line, map.has(line) ? -1 : index));
    return map;
  };
  const am = unique(a),
    bm = unique(b),
    candidates = [];
  a.forEach((line, index) => {
    if (am.get(line) === index && (bm.get(line) ?? -1) >= 0)
      candidates.push([index, bm.get(line)]);
  });
  const tails = [],
    previous = [];
  candidates.forEach((candidate, index) => {
    let low = 0,
      high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (candidates[tails[mid]][1] < candidate[1]) low = mid + 1;
      else high = mid;
    }
    previous[index] = low ? tails[low - 1] : -1;
    tails[low] = index;
  });
  const anchors = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index])
    anchors.push(candidates[index]);
  anchors.reverse();
  const offsets = (items) => {
    const result = [0];
    for (const line of items) result.push(result.at(-1) + line.length);
    return result;
  };
  const ao = offsets(a),
    bo = offsets(b),
    groups = [];
  const add = (a0, a1, b0, b1) => {
    if (a0 === a1 && b0 === b1) return;
    const same = before.slice(a0, a1) === after.slice(b0, b1),
      last = groups.at(-1);
    if (last && last.same === same && last.a1 === a0 && last.b1 === b0) {
      last.a1 = a1;
      last.b1 = b1;
    } else groups.push({ a0, a1, b0, b1, same });
  };
  let ai = 0,
    bi = 0;
  for (const [ax, bx] of anchors) {
    add(ao[ai], ao[ax], bo[bi], bo[bx]);
    add(ao[ax], ao[ax + 1], bo[bx], bo[bx + 1]);
    ai = ax + 1;
    bi = bx + 1;
  }
  add(ao[ai], before.length, bo[bi], after.length);
  const result = [];
  for (const [groupIndex, group] of groups.entries()) {
    let a0 = group.a0,
      b0 = group.b0,
      chunk = 0;
    while (a0 < group.a1 || b0 < group.b1) {
      const cut = (text, start, limit) => {
        let end = Math.min(limit, start + 8000);
        if (end < limit) {
          const newline = text.lastIndexOf("\n", end);
          if (newline >= start) end = newline + 1;
          if (/[\uDC00-\uDFFF]/.test(text[end])) end--;
        }
        return end;
      };
      const a1 = cut(before, a0, group.a1),
        b1 = cut(after, b0, group.b1);
      result.push(
        pair(
          a0 === a1 ? null : part(before, fileIndex, "before", a0, a1),
          b0 === b1 ? null : part(after, fileIndex, "after", b0, b1),
          `${file.filename}:${group.same ? "unchanged" : "changed"}:${groupIndex}:${chunk++}`,
        ),
      );
      a0 = a1;
      b0 = b1;
    }
  }
  return result;
}

/** Direct import graph in the already-fetched inventory; depth two supplies adjacent wiring. */
export function relatedChangedContext(files, seeds) {
  const edges = files.map(
    (_, index) => new Set(changedImportContext(files, new Set([index]))),
  );
  edges.forEach((targets, index) => {
    for (const target of targets) edges[target].add(index);
  });
  const seen = new Set(seeds),
    frontier = [...seeds];
  for (let depth = 0; depth < 2; depth++) {
    const length = frontier.length;
    for (let i = 0; i < length; i++)
      for (const neighbor of edges[frontier.shift()])
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          frontier.push(neighbor);
        }
  }
  return [...seen].sort((a, b) => a - b);
}

export function supplementalUnits(files, fileIndex, compact = false) {
  const file = files[fileIndex];
  const units = pairedUnits([file]);
  const chosen =
    !compact &&
    (units.reduce((n, u) => n + Buffer.byteLength(JSON.stringify(u)), 0) <=
      24000 ||
      file.before === null ||
      file.after === null)
      ? units
      : (file.filename.endsWith(".json") ? units : lineUnits(file, 0)).filter(
          (u) => u.parts.some((p) => p.references.length === 1),
        );
  const selected = [];
  const surroundingLines = compact ? 3 : 12;
  const scope = compact
    ? "complete changed hunks with three surrounding lines; further context is outside this segment"
    : "paired changed hunk with surrounding lines; full file remains in coverage inventory";
  for (const unit of chosen)
    for (const p of unit.parts)
      for (const r of p.references) {
        const source = Buffer.from(file[r.side]);
        let start = r.start,
          end = r.end;
        // Keep enclosing source context around a changed hunk; exact byte references remain explicit.
        for (let n = 0; n < surroundingLines && start > 0; n++) {
          const found = source.lastIndexOf(10, Math.max(0, start - 2));
          start = found < 0 ? 0 : found + 1;
        }
        for (let n = 0; n < surroundingLines && end < source.length; n++) {
          const found = source.indexOf(10, end);
          end = found < 0 ? source.length : found + 1;
        }
        selected.push({
          fileIndex,
          side: r.side,
          start,
          end,
          text: source.subarray(start, end).toString("utf8"),
          scope,
        });
      }
  const merged = [];
  selected.sort(
    (a, b) =>
      a.side.localeCompare(b.side) || a.start - b.start || a.end - b.end,
  );
  for (const current of selected) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.side === current.side &&
      current.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, current.end);
      previous.text = Buffer.from(file[current.side])
        .subarray(previous.start, previous.end)
        .toString("utf8");
    } else merged.push({ ...current });
  }
  // Reuse the existing paired source alignment so identical surrounding text
  // occupies prompt space once while retaining both exact revision references.
  const clipped = [];
  for (const unit of lineUnits(file, fileIndex)) {
    for (const sourcePart of unit.parts) {
      const windows = sourcePart.references.flatMap((reference) =>
        merged
          .filter((range) => range.side === reference.side)
          .map((range) => ({
            reference,
            start: Math.max(range.start, reference.start) - reference.start,
            end: Math.min(range.end, reference.end) - reference.start,
          }))
          .filter((range) => range.end > range.start),
      );
      const boundaries = [
        ...new Set(windows.flatMap((range) => [range.start, range.end])),
      ].sort((a, b) => a - b);
      for (let index = 1; index < boundaries.length; index++) {
        const start = boundaries[index - 1],
          end = boundaries[index];
        const references = windows
          .filter((range) => range.start <= start && range.end >= end)
          .map(({ reference }) => ({
            fileIndex,
            side: reference.side,
            start: reference.start + start,
            end: reference.start + end,
          }));
        if (!references.length) continue;
        clipped.push({
          label: unit.label,
          parts: [
            {
              text: Buffer.from(sourcePart.text)
                .subarray(start, end)
                .toString("utf8"),
              references,
            },
          ],
        });
      }
    }
  }
  return coalescePairedUnits(clipped, files).flatMap((unit) =>
    unit.parts.map((part) => ({
      ...part.references[0],
      text: part.text,
      ...(part.references.length > 1
        ? { otherSides: part.references.slice(1) }
        : {}),
      scope,
    })),
  );
}

/** Join adjacent complete units without introducing semantic cuts or repeating range metadata. */
export function coalescePairedUnits(units, files = []) {
  const merged = [];
  for (const unit of units) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.parts.length === unit.parts.length &&
      previous.parts.every(
        (part, index) =>
          part.references.length === unit.parts[index].references.length &&
          part.references.every((ref, i) => {
            const next = unit.parts[index].references[i];
            return (
              ref.fileIndex === next.fileIndex &&
              ref.side === next.side &&
              ref.end === next.start
            );
          }),
      )
    ) {
      const candidate = {
        label: previous.label.split(" … ")[0] + " … " + unit.label,
        parts: previous.parts.map((part, index) => ({
          text: part.text + unit.parts[index].text,
          references: part.references.map((ref, i) => ({
            ...ref,
            end: unit.parts[index].references[i].end,
          })),
        })),
      };
      if (
        Buffer.byteLength(JSON.stringify(candidate)) <=
        (files[unit.parts[0].references[0].fileIndex]?.filename.endsWith(
          ".json",
        )
          ? 16 * 1024
          : UNIT_BYTES)
      ) {
        merged[merged.length - 1] = candidate;
        continue;
      }
    }
    merged.push(unit);
  }
  return merged;
}

/** Same-file local JSON-pointer closure. Never fetches external documents. */
export function jsonReferenceContext(files, units) {
  const queue = [],
    seen = new Set(),
    definitions = new Set(),
    registries = new Map(),
    contexts = [],
    unresolved = [];
  const primaryRanges = units.flatMap((unit) =>
    unit.parts.flatMap((p) => p.references),
  );
  const registry = (fileIndex, side) => {
    const key = `${fileIndex}:${side}`,
      source = files[fileIndex][side];
    if (!registries.has(key))
      registries.set(
        key,
        jsonSpans(source, true)
          .filter((s) => !s.label.startsWith("structure:"))
          .map((span) => ({
            ...span,
            byteStart: Buffer.byteLength(source.slice(0, span.start)),
            byteEnd: Buffer.byteLength(source.slice(0, span.end)),
          })),
      );
    return registries.get(key);
  };
  const resolve = (fileIndex, side, ref) => {
    const source = files[fileIndex][side];
    const pointer = decodeURIComponent(ref.slice(1));
    if (pointer !== "" && !pointer.startsWith("/"))
      throw Error("not a JSON pointer");
    const span =
      pointer === ""
        ? {
            start: 0,
            end: source.length,
            byteStart: 0,
            byteEnd: Buffer.byteLength(source),
            label: "",
          }
        : registry(fileIndex, side)
            .filter(
              (s) => pointer === s.label || pointer.startsWith(s.label + "/"),
            )
            .sort((a, b) => b.label.length - a.label.length)[0];
    if (!span) throw Error("no semantic target");
    // Resolve the pointer itself, so a nonexistent nested field cannot masquerade as a valid parent.
    let target = JSON.parse(source);
    if (pointer)
      for (const token of pointer.slice(1).split("/")) {
        if (/~(?![01])/.test(token)) throw Error("invalid pointer escape");
        const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
        if (
          target === null ||
          typeof target !== "object" ||
          !Object.hasOwn(target, key)
        )
          throw Error("missing pointer");
        target = target[key];
      }
    return { pointer, span };
  };
  const enqueue = (fileIndex, side, text) => {
    if (!files[fileIndex].filename.endsWith(".json")) return;
    for (const match of text.matchAll(/"\$ref"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
      const ref = JSON.parse('"' + match[1] + '"');
      if (!ref.startsWith("#")) continue;
      const key = `${fileIndex}:${side}:${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const { span } = resolve(fileIndex, side, ref);
        if (
          span &&
          primaryRanges.some(
            (range) =>
              range.fileIndex === fileIndex &&
              range.side === side &&
              range.start <= span.byteStart &&
              range.end >= span.byteEnd,
          )
        )
          continue;
      } catch {
        /* The bounded closure below records unresolved malformed targets. */
      }

      if (
        !definitions.has(`${fileIndex}:${ref}`) &&
        definitions.size >= MAX_JSON_CONTEXT_TARGETS
      ) {
        if (
          !unresolved.some(
            (x) => x.reason === "local reference closure exceeds128 targets",
          )
        )
          unresolved.push({
            fileIndex,
            side,
            reason: "local reference closure exceeds128 targets",
          });
        continue;
      }
      definitions.add(`${fileIndex}:${ref}`);
      queue.push({ fileIndex, side, ref });
    }
  };
  for (const unit of units)
    for (const p of unit.parts)
      for (const r of p.references) enqueue(r.fileIndex, r.side, p.text);
  for (let index = 0; index < queue.length; index++) {
    const { fileIndex, side, ref } = queue[index],
      source = files[fileIndex][side];
    try {
      const { pointer, span } = resolve(fileIndex, side, ref);
      const text = source.slice(span.start, span.end);
      const range = {
        fileIndex,
        side,
        start: Buffer.byteLength(source.slice(0, span.start)),
        end: Buffer.byteLength(source.slice(0, span.end)),
        text,
      };
      if (
        !contexts.some(
          (c) =>
            c.fileIndex === fileIndex &&
            c.side === side &&
            c.parts[0].start === range.start &&
            c.parts[0].end === range.end,
        )
      )
        contexts.push({
          fileIndex,
          side,
          pointer,
          parts: [range],
          role: "local JSON reference",
        });
      enqueue(fileIndex, side, text);
    } catch {
      unresolved.push({
        fileIndex,
        side,
        pointer: ref,
        reason: "local JSON reference target unavailable",
      });
    }
  }
  const paired = [];
  for (const context of contexts) {
    const existing = paired.find(
      (item) =>
        item.fileIndex === context.fileIndex &&
        item.pointer === context.pointer &&
        item.parts[0].text === context.parts[0].text,
    );
    if (existing) {
      const { text: _text, scope: _scope, ...reference } = context.parts[0];
      existing.parts[0].otherSides ??= [];
      existing.parts[0].otherSides.push(reference);
    } else paired.push(context);
  }
  return { contexts: paired, unresolved };
}
