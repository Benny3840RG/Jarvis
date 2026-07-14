from pathlib import Path

path = Path(__file__).resolve().parents[2] / "typescript/convex/memoryChangeSets.ts"
text = path.read_text(encoding="utf-8")

approve_old = '''    const project = await requireProject(ctx, ownerId, changeSet.projectKey);
    if (project.revision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
      );
    }

    const now = Date.now();
'''
approve_new = '''    const project = await requireProject(ctx, ownerId, changeSet.projectKey);
    if (project.revision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
      );
    }
    if (changeSet.state === "approved") return changeSet;

    const now = Date.now();
'''
if approve_old in text:
    text = text.replace(approve_old, approve_new, 1)

reject_old = '''    if (changeSet.state === "rejected") return changeSet;

    const now = Date.now();
'''
reject_new = '''    if (changeSet.state === "rejected") {
      if (changeSet.rejectedReason === reason) return changeSet;
      throw new Error("Rejected memory change set already has a different reason.");
    }

    const now = Date.now();
'''
if reject_old in text:
    text = text.replace(reject_old, reject_new, 1)

path.write_text(text, encoding="utf-8")
