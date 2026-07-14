from pathlib import Path

path = Path(__file__).resolve().parents[2] / "typescript/convex/memoryChangeSets.ts"
text = path.read_text(encoding="utf-8")

approve_old = '''    const changeSet = await requireChangeSet(ctx, ownerId, changeSetId);
    if (changeSet.state === "approved" || changeSet.state === "applied") return changeSet;
    if (changeSet.state === "rejected") {
      throw new Error("Rejected memory change sets cannot be approved.");
    }

    const project = await requireProject(ctx, ownerId, changeSet.projectKey);
    if (changeSet.baseRevision !== expectedRevision || project.revision !== expectedRevision) {
'''
approve_new = '''    const changeSet = await requireChangeSet(ctx, ownerId, changeSetId);
    if (changeSet.baseRevision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, proposal base ${changeSet.baseRevision}.`,
      );
    }
    if (changeSet.state === "applied") return changeSet;
    if (changeSet.state === "rejected") {
      throw new Error("Rejected memory change sets cannot be approved.");
    }

    const project = await requireProject(ctx, ownerId, changeSet.projectKey);
    if (project.revision !== expectedRevision) {
'''
if approve_old in text:
    text = text.replace(approve_old, approve_new)

apply_old = '''    const changeSet = await requireChangeSet(ctx, ownerId, changeSetId);
    const project = await requireProject(ctx, ownerId, changeSet.projectKey);

    if (changeSet.state === "applied") {
'''
apply_new = '''    const changeSet = await requireChangeSet(ctx, ownerId, changeSetId);
    if (changeSet.baseRevision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, proposal base ${changeSet.baseRevision}.`,
      );
    }
    const project = await requireProject(ctx, ownerId, changeSet.projectKey);

    if (changeSet.state === "applied") {
'''
if apply_old in text:
    text = text.replace(apply_old, apply_new)

apply_conflict_old = '''    if (changeSet.baseRevision !== expectedRevision || project.revision !== expectedRevision) {
'''
apply_conflict_new = '''    if (project.revision !== expectedRevision) {
'''
text = text.replace(apply_conflict_old, apply_conflict_new)
path.write_text(text, encoding="utf-8")
