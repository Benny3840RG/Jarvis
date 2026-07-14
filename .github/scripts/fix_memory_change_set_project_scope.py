from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old in text:
        text = text.replace(old, new)
        path.write_text(text, encoding="utf-8")


service = ROOT / "typescript/src/memory/memoryChangeSets.ts"
replace(
    service,
    '  get(changeSetId: string): Promise<MemoryChangeSet | null>;\n',
    '  get(input: { changeSetId: string; projectId: string }): Promise<MemoryChangeSet | null>;\n',
)
replace(
    service,
    '  approve(input: { changeSetId: string; expectedRevision: number }): Promise<MemoryChangeSet>;\n',
    '  approve(input: {\n    changeSetId: string;\n    projectId: string;\n    expectedRevision: number;\n  }): Promise<MemoryChangeSet>;\n',
)
replace(
    service,
    '  reject(input: { changeSetId: string; reason: string }): Promise<MemoryChangeSet>;\n',
    '  reject(input: { changeSetId: string; projectId: string; reason: string }): Promise<MemoryChangeSet>;\n',
)
replace(
    service,
    '  apply(input: {\n    changeSetId: string;\n    expectedRevision: number;\n',
    '  apply(input: {\n    changeSetId: string;\n    projectId: string;\n    expectedRevision: number;\n',
)

adapter = ROOT / "typescript/src/persistence/convexMemoryChangeSets.ts"
replace(
    adapter,
    '''  async get(changeSetId: string): Promise<MemoryChangeSet | null> {
    const row = await this.client.query(memoryChangeSetFunctions.get, {
      serviceToken: this.serviceToken,
      changeSetId,
    });
''',
    '''  async get(input: Parameters<MemoryChangeSetService["get"]>[0]): Promise<MemoryChangeSet | null> {
    const row = await this.client.query(memoryChangeSetFunctions.get, {
      serviceToken: this.serviceToken,
      changeSetId: input.changeSetId,
      projectKey: input.projectId,
    });
''',
)
replace(
    adapter,
    '''      changeSetId: input.changeSetId,
      expectedRevision: input.expectedRevision,
    });
    return changeSetFromConvex(row as ChangeSetRow);
  }

  async reject''',
    '''      changeSetId: input.changeSetId,
      projectKey: input.projectId,
      expectedRevision: input.expectedRevision,
    });
    return changeSetFromConvex(row as ChangeSetRow);
  }

  async reject''',
)
replace(
    adapter,
    '''      changeSetId: input.changeSetId,
      reason: input.reason,
    });
    return changeSetFromConvex(row as ChangeSetRow);
  }

  async apply''',
    '''      changeSetId: input.changeSetId,
      projectKey: input.projectId,
      reason: input.reason,
    });
    return changeSetFromConvex(row as ChangeSetRow);
  }

  async apply''',
)
replace(
    adapter,
    '''      changeSetId: input.changeSetId,
      expectedRevision: input.expectedRevision,
    });
    const typed = result as {''',
    '''      changeSetId: input.changeSetId,
      projectKey: input.projectId,
      expectedRevision: input.expectedRevision,
    });
    const typed = result as {''',
)

controller = ROOT / "typescript/src/http/memoryChangeSetController.ts"
replace(
    controller,
    '''  @Get(":changeSetId")
  async get(@Param("changeSetId") changeSetId: string) {
    try {
      const changeSet = await this.requireService().get(changeSetId);
''',
    '''  @Get(":changeSetId")
  async get(
    @Param("projectId") projectId: string,
    @Param("changeSetId") changeSetId: string,
  ) {
    try {
      const changeSet = await this.requireService().get({ changeSetId, projectId });
''',
)
replace(
    controller,
    '''  async approve(@Param("changeSetId") changeSetId: string, @Body() body: unknown) {
''',
    '''  async approve(
    @Param("projectId") projectId: string,
    @Param("changeSetId") changeSetId: string,
    @Body() body: unknown,
  ) {
''',
)
replace(
    controller,
    '''      return await this.requireService().approve({ changeSetId, expectedRevision });
''',
    '''      return await this.requireService().approve({ changeSetId, projectId, expectedRevision });
''',
)
replace(
    controller,
    '''  async reject(@Param("changeSetId") changeSetId: string, @Body() body: unknown) {
''',
    '''  async reject(
    @Param("projectId") projectId: string,
    @Param("changeSetId") changeSetId: string,
    @Body() body: unknown,
  ) {
''',
)
replace(
    controller,
    '''      return await this.requireService().reject({ changeSetId, reason });
''',
    '''      return await this.requireService().reject({ changeSetId, projectId, reason });
''',
)
replace(
    controller,
    '''  async apply(@Param("changeSetId") changeSetId: string, @Body() body: unknown) {
''',
    '''  async apply(
    @Param("projectId") projectId: string,
    @Param("changeSetId") changeSetId: string,
    @Body() body: unknown,
  ) {
''',
)
replace(
    controller,
    '''      return await this.requireService().apply({ changeSetId, expectedRevision });
''',
    '''      return await this.requireService().apply({ changeSetId, projectId, expectedRevision });
''',
)

convex = ROOT / "typescript/convex/memoryChangeSets.ts"
replace(
    convex,
    '''  ownerId: string,
  changeSetId: string,
): Promise<Doc<"memoryChangeSets">> {
''',
    '''  ownerId: string,
  projectKey: string,
  changeSetId: string,
): Promise<Doc<"memoryChangeSets">> {
''',
)
replace(
    convex,
    '''  if (!changeSet) throw new Error("Memory change set does not exist.");
  return changeSet;
''',
    '''  if (!changeSet || changeSet.projectKey !== projectKey) {
    throw new Error("Memory change set does not exist.");
  }
  return changeSet;
''',
)
replace(
    convex,
    '''  args: { serviceToken: v.string(), changeSetId: v.string() },
''',
    '''  args: { serviceToken: v.string(), projectKey: v.string(), changeSetId: v.string() },
''',
)
replace(
    convex,
    '''    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("memoryChangeSets")
''',
    '''    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const changeSet = await ctx.db
      .query("memoryChangeSets")
''',
)
replace(
    convex,
    '''      )
      .unique();
  },
});

export const listRecent''',
    '''      )
      .unique();
    return changeSet?.projectKey === projectKey ? changeSet : null;
  },
});

export const listRecent''',
)
for operation in ["approve", "reject", "apply"]:
    marker = f'''export const {operation} = mutation({{
  args: {{
    serviceToken: v.string(),
    changeSetId: v.string(),
'''
    replacement = f'''export const {operation} = mutation({{
  args: {{
    serviceToken: v.string(),
    projectKey: v.string(),
    changeSetId: v.string(),
'''
    replace(convex, marker, replacement)

replace(
    convex,
    '''    const changeSetId = cleanRequiredText(args.changeSetId, "Memory change set ID");
    const expectedRevision = requirePositiveRevision(args.expectedRevision, "Expected revision");
    const changeSet = await requireChangeSet(ctx, ownerId, changeSetId);
''',
    '''    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const changeSetId = cleanRequiredText(args.changeSetId, "Memory change set ID");
    const expectedRevision = requirePositiveRevision(args.expectedRevision, "Expected revision");
    const changeSet = await requireChangeSet(ctx, ownerId, projectKey, changeSetId);
''',
)
replace(
    convex,
    '''    const changeSetId = cleanRequiredText(args.changeSetId, "Memory change set ID");
    const reason = cleanRequiredText(args.reason, "Rejection reason");
    const changeSet = await requireChangeSet(ctx, ownerId, changeSetId);
''',
    '''    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const changeSetId = cleanRequiredText(args.changeSetId, "Memory change set ID");
    const reason = cleanRequiredText(args.reason, "Rejection reason");
    const changeSet = await requireChangeSet(ctx, ownerId, projectKey, changeSetId);
''',
)

http_test = ROOT / "typescript/tests/memoryChangeSetHttp.test.ts"
replace(
    http_test,
    '''    async get() {
      return changeSet();
''',
    '''    async get(input) {
      return input.projectId === "project-1" ? changeSet() : null;
''',
)
replace(
    http_test,
    '''          throw new Error("Project revision conflict: expected 3, current 4. token=current-secret");
''',
    '''          throw new Error("Project revision conflict: expected 3, current 4. token=current-secret");
''',
)
if 'returns 404 when a change set belongs to another project' not in http_test.read_text(encoding="utf-8"):
    text = http_test.read_text(encoding="utf-8")
    marker = '''  it("maps revision conflicts without leaking backend details", async () => {
'''
    addition = '''  it("returns 404 when a change set belongs to another project", async () => {
    const app = await makeApp(successfulService());
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-2/memory-change-sets/change-1",
      headers: authHeaders(),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().type, "urn:jarvis:problem:memory-change-set-not-found");
  });

'''
    text = text.replace(marker, addition + marker)
    http_test.write_text(text, encoding="utf-8")

adapter_test = ROOT / "typescript/tests/convexMemoryChangeSets.test.ts"
replace(
    adapter_test,
    '''    const result = await service.apply({ changeSetId: "change-1", expectedRevision: 3 });
''',
    '''    const result = await service.apply({
      changeSetId: "change-1",
      projectId: "project-1",
      expectedRevision: 3,
    });
''',
)
