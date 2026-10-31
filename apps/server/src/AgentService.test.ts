import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { CreateAgent, UpdateAgent } from "@paws/contracts";
import { describe, expect, it } from "vite-plus/test";
import { workspaceLayout } from "@paws/runtime";
import { makeAgentService } from "./AgentService.ts";

async function temporaryRoot() {
  await Fs.mkdir("/tmp/codex", { recursive: true });

  return Fs.mkdtemp("/tmp/codex/paws-test-");
}

describe("agent persistence and workspace provisioning", () => {
  it("persists named agents and provisions disjoint directories across restarts", async () => {
    const root = await temporaryRoot();
    let service = makeAgentService(root);

    try {
      const first = await Effect.runPromise(
        service.create({
          name: "Ada",
        }),
      );
      const second = await Effect.runPromise(
        service.create({
          name: "Ada",
        }),
      );
      const firstLayout = workspaceLayout(root, first.id);
      const secondLayout = workspaceLayout(root, second.id);
      await Fs.writeFile(
        Path.join(firstLayout.workspace, "private.txt"),
        "first",
      );
      expect(await Fs.readdir(secondLayout.workspace)).toEqual([]);
      expect(await Fs.stat(firstLayout.skills)).toBeDefined();
      expect(await Fs.stat(secondLayout.browserProfile)).toBeDefined();
      service.close();
      service = makeAgentService(root);
      expect(await Effect.runPromise(service.list())).toEqual([first, second]);
    } finally {
      service.close();
      await Fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid names before provisioning or persistence", async () => {
    const root = await temporaryRoot();
    const service = makeAgentService(root);

    try {
      await expect(
        Effect.runPromise(
          service.create({
            name: "  ",
          }),
        ),
      ).rejects.toThrow();
      expect(await Effect.runPromise(service.list())).toEqual([]);
      expect((await Fs.readdir(root)).includes("agents")).toBe(false);
    } finally {
      service.close();
      await Fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal and absolute paths in agent identifiers", () => {
    for (const id of ["../escape", "/tmp/escape", "", "agent/../../escape"]) {
      expect(() => workspaceLayout("/tmp/codex/paws", id)).toThrow(
        "Invalid agent ID",
      );
    }
  });
});

it("removes legacy configuration while preserving agent identity across restarts", async () => {
  const root = await temporaryRoot();
  const db = new DatabaseSync(Path.join(root, "state.sqlite"));
  const legacy = {
    id: "bb06b940-1bc0-4cb7-8695-3b4d07f00793",
    name: "Ada",
    role: "reviewer",
    personality: "Careful",
    specialization: "Code review",
    instructions: "Review independently.",
    provider: "codex",
    status: "configured",
    createdAt: "2026-10-31T00:00:00.000Z",
  };
  db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.prepare("INSERT INTO agents (id, data) VALUES (?, ?)").run(
    legacy.id,
    JSON.stringify(legacy),
  );
  db.close();
  let service = makeAgentService(root);

  try {
    const expected = [
      {
        id: legacy.id,
        name: legacy.name,
        provider: legacy.provider,
        status: legacy.status,
        createdAt: legacy.createdAt,
      },
    ];
    expect(await Effect.runPromise(service.list())).toEqual(expected);
    service.close();
    service = makeAgentService(root);
    expect(await Effect.runPromise(service.list())).toEqual(expected);
    const stored = new DatabaseSync(Path.join(root, "state.sqlite"));

    try {
      const row = stored.prepare("SELECT data FROM agents").get();
      expect(JSON.parse(String(row?.data))).toEqual(expected[0]);
    } finally {
      stored.close();
    }
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("persists renames without changing identity or workspace contents", async () => {
  const root = await temporaryRoot();
  let service = makeAgentService(root);

  try {
    const agent = await Effect.runPromise(service.create({ name: "Ada" }));
    const layout = workspaceLayout(root, agent.id);
    const file = Path.join(layout.workspace, "work.txt");
    await Fs.writeFile(file, "Keep my work");
    const updated = await Effect.runPromise(
      service.update(agent.id, { name: "  Grace  " }),
    );
    expect(updated).toEqual({ ...agent, name: "Grace" });

    for (const name of [" ", "x".repeat(81)]) {
      await expect(
        Effect.runPromise(service.update(agent.id, { name })),
      ).rejects.toThrow();
    }

    service.close();
    service = makeAgentService(root);
    expect(await Effect.runPromise(service.list())).toEqual([updated]);
    expect(await Fs.readFile(file, "utf8")).toBe("Keep my work");
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("deletes only the selected agent and preserves workspace files after restart", async () => {
  const root = await temporaryRoot();
  let service = makeAgentService(root);

  try {
    const first = await Effect.runPromise(service.create({ name: "Ada" }));
    const second = await Effect.runPromise(service.create({ name: "Grace" }));
    const layout = workspaceLayout(root, first.id);
    const file = Path.join(layout.workspace, "keep.txt");
    await Fs.writeFile(file, "Keep this work");
    expect(await Effect.runPromise(service.remove(first.id))).toBe(true);
    expect(await Effect.runPromise(service.remove(first.id))).toBe(false);
    service.close();
    service = makeAgentService(root);
    expect(await Effect.runPromise(service.list())).toEqual([second]);
    expect(await Fs.readFile(file, "utf8")).toBe("Keep this work");
    expect(
      await Fs.stat(workspaceLayout(root, second.id).workspace),
    ).toBeDefined();
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("persists avatar changes across restarts and preserves them on name-only updates", async () => {
  const root = await temporaryRoot();
  let service = makeAgentService(root);

  try {
    const avatar = { animal: "fox", color: "red" } as const;
    const agent = await Effect.runPromise(
      service.create({ name: "Ada", avatar }),
    );
    expect(agent.avatar).toEqual(avatar);
    const nextAvatar = { animal: "rabbit", color: "pink" } as const;
    const updated = await Effect.runPromise(
      service.update(agent.id, { name: "Ada", avatar: nextAvatar }),
    );
    expect(updated).toEqual({ ...agent, avatar: nextAvatar });
    service.close();
    service = makeAgentService(root);
    expect(await Effect.runPromise(service.list())).toEqual([updated]);
    const renamed = await Effect.runPromise(
      service.update(agent.id, { name: "Grace" }),
    );
    expect(renamed?.avatar).toEqual(nextAvatar);
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("rejects unknown animals and colors at the wire boundary", () => {
  for (const schema of [CreateAgent, UpdateAgent]) {
    for (const avatar of [
      { animal: "dragon", color: "red" },
      { animal: "cat", color: "arbitrary-css" },
      { animal: "cat" },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(schema)({ name: "Ada", avatar }),
      ).toThrow();
    }
  }
});

it("replaces saved tiger avatars with mice while preserving color and identity", async () => {
  const root = await temporaryRoot();
  const legacy = {
    id: "legacy-tiger",
    name: "Ada",
    avatar: { animal: "tiger", color: "orange" },
    provider: "codex",
    status: "configured",
    createdAt: "2026-11-01T00:00:00.000Z",
  };
  const db = new DatabaseSync(Path.join(root, "state.sqlite"));
  db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.prepare("INSERT INTO agents (id, data) VALUES (?, ?)").run(
    legacy.id,
    JSON.stringify(legacy),
  );
  db.close();
  let service = makeAgentService(root);

  try {
    const expected = {
      ...legacy,
      avatar: { animal: "mouse", color: "orange" },
    };
    expect(await Effect.runPromise(service.list())).toEqual([expected]);
    service.close();
    service = makeAgentService(root);
    expect(await Effect.runPromise(service.list())).toEqual([expected]);
    const stored = new DatabaseSync(Path.join(root, "state.sqlite"));

    try {
      const row = stored.prepare("SELECT data FROM agents").get();
      expect(JSON.parse(String(row?.data))).toEqual(expected);
    } finally {
      stored.close();
    }
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
