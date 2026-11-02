import * as Fs from "node:fs/promises";
import * as Path from "node:path";
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
