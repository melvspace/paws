import * as Fs from "node:fs/promises";
import { Effect, Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { makeMemoryService } from "./MemoryService.ts";
import { agentContext, memoryTool, withMemoryContext } from "./teamContext.ts";

it("preserves legacy context, isolates owners, detects stale edits, and persists entries across restarts", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-memories-");
  let agents = makeAgentService(root);

  try {
    const team = (await Effect.runPromise(
      agents.saveTeam({ name: "Team", memory: "Shared fact" }),
    ))!;
    const agent = await Effect.runPromise(
      agents.create({ name: "Ada", memory: "Private fact", teamId: team.id }),
    );
    const outsider = await Effect.runPromise(agents.create({ name: "Grace" }));
    const service = makeMemoryService(root);
    const owner = { kind: "agents", id: agent.id } as const;
    const run = (input: Parameters<typeof service.execute>[1]) =>
      Effect.runPromise(service.execute(owner, input));
    const legacy = await run({ action: "list" });
    expect(legacy).toMatchObject([{ id: "legacy", text: "Private fact" }]);
    const created = await run({ action: "create", text: "  Second fact  " });
    expect(created).toHaveLength(2);
    const entry = created[1]!;
    expect(entry.text).toBe("Second fact");
    await run({
      action: "update",
      id: entry.id,
      text: "Updated fact",
      expected: "Second fact",
    });
    await expect(
      run({
        action: "update",
        id: entry.id,
        text: "Stale edit",
        expected: "Second fact",
      }),
    ).rejects.toThrow("Memory changed");
    await expect(run({ action: "create", text: " " })).rejects.toThrow();
    await expect(
      run({ action: "create", text: "x".repeat(16001) }),
    ).rejects.toThrow();
    expect(() =>
      memoryTool(root, outsider.id, { action: "list", teamId: team.id }),
    ).toThrow("Join");
    expect(memoryTool(root, outsider.id, { action: "list" })).toEqual({
      entries: [],
    });
    memoryTool(root, agent.id, {
      action: "create",
      teamId: team.id,
      text: "Team entry",
    });
    await Effect.runPromise(agents.saveTeam({ name: "Renamed" }, team.id));
    expect(withMemoryContext(root, agent.id, "Hello")).not.toContain(
      "Team entry",
    );
    expect(agentContext(root, agent.id).memory).toBe(
      "Private fact\n\nUpdated fact",
    );
    agents.close();
    agents = makeAgentService(root);
    expect(await run({ action: "list" })).toHaveLength(2);
    await run({ action: "delete", id: "legacy", expected: "Private fact" });
    await expect(
      run({ action: "delete", id: entry.id, expected: "Stale fact" }),
    ).rejects.toThrow();
    expect(
      await run({ action: "delete", id: entry.id, expected: "Updated fact" }),
    ).toEqual([]);
    expect(agentContext(root, agent.id).memory).toBe("");
    await Effect.runPromise(agents.remove(agent.id));
    await expect(run({ action: "list" })).rejects.toThrow(
      "owner no longer exists",
    );
  } finally {
    agents.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it.each(["update", "move"])(
  "preserves memory changes during an agent %s transition",
  async (operation) => {
    await Fs.mkdir("/tmp/codex", { recursive: true });
    const root = await Fs.mkdtemp("/tmp/codex/paws-memory-transition-");
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const agents = makeAgentService(
      root,
      () => true,
      async () => {
        entered();
        await blocked;
      },
    );

    try {
      const agent = await Effect.runPromise(
        agents.create({ name: "Ada", memory: "Old fact" }),
      );
      const team = (await Effect.runPromise(
        agents.saveTeam({ name: "Team", memory: "" }),
      ))!;
      const transition = Effect.runPromise(
        operation === "update"
          ? agents.update(agent.id, { name: "Ada", sandbox: true })
          : agents.moveTeam(agent.id, { fromTeamId: null, toTeamId: team.id }),
      );
      await started;
      memoryTool(root, agent.id, {
        action: "delete",
        id: "legacy",
        expected: "Old fact",
      });
      memoryTool(root, agent.id, { action: "create", text: "New fact" });
      release();
      const result = await transition;
      expect(result?.memories).toMatchObject([{ text: "New fact" }]);
      expect(agentContext(root, agent.id).memory).toBe("New fact");
    } finally {
      release();
      agents.close();
      await Fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("includes only bounded essential memories and never replays memories from old routine snapshots", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-memory-context-");
  const agents = makeAgentService(root);

  try {
    const team = (await Effect.runPromise(
      agents.saveTeam({ name: "Team", memory: "Legacy team detail" }),
    ))!;
    const agent = await Effect.runPromise(
      agents.create({
        name: "Ada",
        teamId: team.id,
        memory: "Legacy personal detail",
      }),
    );
    memoryTool(root, agent.id, {
      action: "create",
      text: "Unrelated task detail",
    });
    memoryTool(root, agent.id, {
      action: "create",
      teamId: team.id,
      text: "Unrelated shared detail",
    });
    const emptyAgent = await Effect.runPromise(
      agents.create({ name: "Grace" }),
    );
    const emptyPrompt = withMemoryContext(root, emptyAgent.id, "New request");
    expect(emptyPrompt).toContain('"essential":[]');
    expect(emptyPrompt).toContain("replaces all earlier saved-memory blocks");
    const before = withMemoryContext(root, agent.id, "Current request");
    expect(before).not.toContain("Legacy personal detail");
    expect(before).not.toContain("Legacy team detail");
    expect(before).not.toContain("Unrelated task detail");
    expect(before).not.toContain("Unrelated shared detail");
    expect(before).toContain('"searchableCount":4');
    memoryTool(root, agent.id, {
      action: "create",
      text: "Prefer concise replies",
      inclusion: "essential",
    });
    memoryTool(root, agent.id, {
      action: "create",
      teamId: team.id,
      text: "Use metric units",
      inclusion: "essential",
    });
    const prompt = withMemoryContext(root, agent.id, "Current request");
    expect(prompt).toContain("Prefer concise replies");
    expect(prompt).toContain("Use metric units");
    expect(prompt).toContain("untrusted historical data");
    expect(prompt).toContain("current user request");
    expect(prompt).not.toContain("Unrelated task detail");
    const snapshot = agentContext(root, agent.id);
    const entries = await Effect.runPromise(
      makeMemoryService(root).execute(
        { kind: "agents", id: agent.id },
        { action: "list" },
      ),
    );
    const preference = entries.find(
      (entry) => entry.text === "Prefer concise replies",
    )!;
    memoryTool(root, agent.id, {
      action: "delete",
      id: preference.id,
      expected: preference.text,
    });
    const resumed = withMemoryContext(root, agent.id, "Continue", snapshot);
    expect(resumed).not.toContain("Prefer concise replies");
    expect(resumed).not.toContain("Legacy personal detail");
    await Effect.runPromise(
      agents.moveTeam(agent.id, { fromTeamId: team.id, toTeamId: null }),
    );
    expect(
      withMemoryContext(root, agent.id, "Continue", snapshot),
    ).not.toContain("Use metric units");
  } finally {
    agents.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("searches within the owner's memories with bounded summaries and full reads on demand", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-memory-search-");
  const agents = makeAgentService(root);

  try {
    const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
    const other = await Effect.runPromise(agents.create({ name: "Grace" }));
    const service = makeMemoryService(root);
    const owner = { kind: "agents", id: agent.id } as const;
    await Effect.runPromise(
      service.execute(owner, {
        action: "create",
        text: "MAIL links: use direct links",
      }),
    );
    const longText = `Mail links for support: ${"details ".repeat(150)}`.trim();
    const created = await Effect.runPromise(
      service.execute(owner, { action: "create", text: longText }),
    );
    const long = created.at(-1)!;
    await Effect.runPromise(
      service.execute(
        { kind: "agents", id: other.id },
        { action: "create", text: "Mail links for other agent" },
      ),
    );
    const matches = await Effect.runPromise(
      service.execute(owner, { action: "search", query: "mail links" }),
    );
    expect(matches).toHaveLength(2);
    expect(matches.every((entry) => entry.inclusion === "searchable")).toBe(
      true,
    );
    expect(
      await Effect.runPromise(
        service.execute(owner, { action: "search", query: "mail absent" }),
      ),
    ).toEqual([]);
    expect(
      await Effect.runPromise(
        service.execute(owner, { action: "search", query: "mail", limit: 1 }),
      ),
    ).toHaveLength(1);
    await expect(
      Effect.runPromise(
        service.execute(owner, { action: "search", query: " " }),
      ),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        service.execute(owner, { action: "search", query: "mail", limit: 11 }),
      ),
    ).rejects.toThrow();
    const summary = memoryTool(root, agent.id, {
      action: "search",
      query: "support",
    });
    expect(summary).toMatchObject({
      entries: [{ id: long.id, text: longText.slice(0, 600), truncated: true }],
    });
    expect(
      memoryTool(root, agent.id, { action: "read", id: long.id }),
    ).toMatchObject({ entry: { text: longText } });
    expect(() =>
      memoryTool(root, other.id, { action: "read", id: long.id }),
    ).toThrow();

    for (let index = 0; index < 10; index++) {
      await Effect.runPromise(
        service.execute(owner, { action: "create", text: `Entry ${index}` }),
      );
    }

    const page = memoryTool(root, agent.id, { action: "list" });
    expect(page).toMatchObject({
      entries: expect.any(Array),
      nextCursor: expect.any(String),
    });
    const decoded = Schema.decodeUnknownSync(
      Schema.Struct({
        entries: Schema.Array(Schema.Unknown),
        nextCursor: Schema.String,
      }),
    )(page);
    expect(decoded.entries).toHaveLength(10);
    const next = Schema.decodeUnknownSync(
      Schema.Struct({
        entries: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    )(
      memoryTool(root, agent.id, { action: "list", after: decoded.nextCursor }),
    );
    expect(next.entries.map((entry) => entry.text)).toEqual([
      "Entry 8",
      "Entry 9",
    ]);
  } finally {
    agents.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("enforces essential count and UTF-8 byte limits and allows demotion to searchable", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-essential-limit-");
  const agents = makeAgentService(root);

  try {
    const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
    const service = makeMemoryService(root);
    const owner = { kind: "agents", id: agent.id } as const;
    const run = (input: Parameters<typeof service.execute>[1]) =>
      Effect.runPromise(service.execute(owner, input));
    const large = await run({ action: "create", text: "é".repeat(1000) });
    await expect(
      run({
        action: "update",
        id: large[0]!.id,
        text: large[0]!.text,
        expected: large[0]!.text,
        inclusion: "essential",
      }),
    ).rejects.toThrow("2048 bytes");
    expect((await run({ action: "list" }))[0]!.inclusion).toBe("searchable");

    for (let index = 0; index < 4; index++) {
      await run({
        action: "create",
        text: `Preference ${index}`,
        inclusion: "essential",
      });
    }

    await expect(
      run({
        action: "create",
        text: "Fifth preference",
        inclusion: "essential",
      }),
    ).rejects.toThrow("4 entries");
    const first = (await run({ action: "list" }))[1]!;
    await run({
      action: "update",
      id: first.id,
      text: first.text,
      expected: first.text,
      inclusion: "searchable",
    });
    await run({
      action: "create",
      text: "Fifth preference",
      inclusion: "essential",
    });
    expect(
      (await run({ action: "list" })).filter(
        (entry) => entry.inclusion === "essential",
      ),
    ).toHaveLength(4);
  } finally {
    agents.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
