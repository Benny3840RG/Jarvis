/** A single regular-file/directory mode, never a full ls listing or a path. */
export function canonicalFileMode(output: string): string | null {
  const match = /^[ \t]*([-d][r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-])[ \t]*$/.exec(output);
  // JavaScript's $ can match before a final newline; require the entire input.
  return match !== null && match[0] === output ? match[1]! : null;
}

function permissions(bits: string, directory: boolean): string {
  const labels: string[] = [];
  if (bits[0] === "r") labels.push(directory ? "list entries" : "read");
  if (bits[1] === "w") labels.push(directory ? "modify entries" : "write");
  if (bits[2] === "x" || bits[2] === "s" || bits[2] === "t") {
    labels.push(directory ? "traverse" : "execute");
  }
  return labels.length > 0 ? labels.join(", ") : "no permissions";
}

/** Fixed educational text derived from bits; never echoes supplied text. */
export function fileModeSummary(output: string): string | null {
  const mode = canonicalFileMode(output);
  if (mode === null) return null;
  const directory = mode[0] === "d";
  const special: string[] = [];
  if (mode[3] === "s" || mode[3] === "S") {
    special.push(
      directory
        ? "setuid is set; it is normally ignored on Linux directories"
        : "setuid is set; eligible executable files can run with the file owner's effective user ID, subject to system restrictions",
    );
  }
  if (mode[6] === "s" || mode[6] === "S") {
    special.push(
      directory
        ? "setgid is set; new entries normally inherit the directory's group"
        : "setgid is set; eligible executable files can run with the file group's effective group ID, subject to system restrictions",
    );
  }
  if (mode[9] === "t" || mode[9] === "T") {
    special.push(
      directory
        ? "sticky is set; deletion and renaming of entries are restricted by ownership and privilege, in addition to ordinary permissions"
        : "sticky is set; it is normally ignored on Linux regular files",
    );
  }
  return [
    `Supplied mode for a ${directory ? "directory" : "regular file"}.`,
    `Owner: ${permissions(mode.slice(1, 4), directory)}.`,
    `Group: ${permissions(mode.slice(4, 7), directory)}.`,
    `Others: ${permissions(mode.slice(7, 10), directory)}.`,
    `Special bits: ${special.length > 0 ? special.join("; ") : "none"}.`,
    "Lowercase s/t includes execute or traverse; uppercase S/T does not.",
    ...(directory ? ["Directory operations can require both modify and traverse permission."] : []),
    "Mode bits alone do not establish effective access. ACLs, parent directories, mount options, identities and other system controls can change the result.",
  ].join(" ");
}

/** Octal modes omit object type, so callers must supply it separately. */
export function canonicalOctalMode(output: string): string | null {
  const match = /^[ \t]*([0-7]{3,4})[ \t]*$/.exec(output);
  return match !== null && match[0] === output ? match[1]!.padStart(4, "0") : null;
}

export function octalFileModeSummary(output: string, kind: "file" | "directory"): string | null {
  const octal = canonicalOctalMode(output);
  if (octal === null) return null;
  const special = Number(octal[0]);
  const groups = [1, 2, 3].map((index) => {
    const bits = Number(octal[index]);
    const execute = (bits & 1) !== 0;
    const specialBit = [4, 2, 1][index - 1]!;
    const marker = index === 3 ? "t" : "s";
    const final =
      (special & specialBit) !== 0
        ? execute
          ? marker
          : marker.toUpperCase()
        : execute
          ? "x"
          : "-";
    return `${(bits & 4) !== 0 ? "r" : "-"}${(bits & 2) !== 0 ? "w" : "-"}${final}`;
  });
  return fileModeSummary(`${kind === "directory" ? "d" : "-"}${groups.join("")}`);
}

export function canonicalUmask(output: string): string | null {
  const octal = canonicalOctalMode(output);
  return octal !== null && octal[0] === "0" ? octal : null;
}

/** Illustrative creation requests only; no process mask or file is changed. */
export function umaskSummary(output: string): string | null {
  const canonical = canonicalUmask(output);
  if (canonical === null) return null;
  const mask = Number.parseInt(canonical, 8);
  const file = (0o666 & ~mask).toString(8).padStart(4, "0");
  const directory = (0o777 & ~mask).toString(8).padStart(4, "0");
  return [
    `Without a default ACL, a 0666 file request yields ${file}; a 0777 directory request yields ${directory}.`,
    "These are illustrative requested modes, not verified defaults. Applications may request different permissions; a parent default ACL changes how creation permissions are determined. A mask removes bits; it never grants execute permission absent from the creation request. Existing permissions are unchanged.",
    octalFileModeSummary(file, "file")!,
    octalFileModeSummary(directory, "directory")!,
  ].join(" ");
}

/** Nine-bit creation calculation only; special bits and default ACLs are out of scope. */
export function creationModeSummary(
  output: string,
  requestedMode: string,
  kind: "file" | "directory",
): string | null {
  const mask = canonicalUmask(output);
  const requested = canonicalUmask(requestedMode);
  if (mask === null || requested === null) return null;
  const result = (Number.parseInt(requested, 8) & ~Number.parseInt(mask, 8))
    .toString(8)
    .padStart(4, "0");
  return [
    "Without a default ACL, the supplied " +
      requested +
      " " +
      kind +
      " creation request with mask " +
      mask +
      " yields " +
      result +
      ".",
    "This calculation only removes requested permission bits; it does not grant unrequested bits. A parent default ACL changes creation permission handling, and other system controls can affect the result. Special-bit creation and inherited setgid are outside this calculation. Existing permissions are unchanged. No file is created and no process mask is changed.",
    octalFileModeSummary(result, kind)!,
  ].join(" ");
}
