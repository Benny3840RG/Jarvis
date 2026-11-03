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
