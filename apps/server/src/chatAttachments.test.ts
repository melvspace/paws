import { mkdtemp, mkdir, writeFile, symlink, rm, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { saveWorkspaceAttachments } from "./chatAttachments.ts";

it("refuses files outside the workspace, symlink escapes, directories and oversized files", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-attachment-test-");
  const agent = randomUUID();
  const workspace = `${root}/agents/${agent}/workspace`;
  await mkdir(workspace, { recursive: true });

  try {
    await writeFile(`${root}/private`, "private value");
    await symlink(`${root}/private`, `${workspace}/escape`);
    const large = await open(`${workspace}/large`, "w");
    await large.truncate(64 * 1024 * 1024 + 1);
    await large.close();

    for (const path of [
      "/tmp/paws-secrets/value",
      "../../../private",
      "/workspace/escape",
      "/workspace/large",
      "/workspace/",
    ])
      await expect(
        saveWorkspaceAttachments(root, agent, [{ path }]),
      ).rejects.toThrow();

    await expect(
      saveWorkspaceAttachments(
        root,
        agent,
        Array.from({ length: 5 }, () => ({ path: "file" })),
      ),
    ).rejects.toThrow("Too many");
    await writeFile(`${workspace}/note.txt`, "hello");
    const files = await saveWorkspaceAttachments(root, agent, [
      { path: "note.txt", name: 'hello\r\n"world.txt' },
    ]);
    expect(files[0]?.name).toBe("hello___world.txt");
    expect(files[0]?.size).toBe(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a runtime-controlled workspace symlink into administrative files", async () => {
  const { Effect } = await import("effect");
  const { makeAgentService } = await import("./AgentService.ts");
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-workspace-escape-");
  const service = makeAgentService(root);

  try {
    const team = (await Effect.runPromise(
      service.saveTeam({ name: "Team", memory: "" }),
    ))!;
    const agent = await Effect.runPromise(
      service.create({ name: "Agent", teamId: team.id }),
    );
    const workspace = `${root}/teams/${team.id}/agents/${agent.id}/workspace`;
    await writeFile(`${root}/private`, "private");
    await rm(workspace, { recursive: true });
    await symlink(root, workspace);
    await expect(
      saveWorkspaceAttachments(root, agent.id, [{ path: "private" }]),
    ).rejects.toThrow("escaped");
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts host workspace aliases and canonical paths while preserving containment", async () => {
  const { Effect } = await import("effect");
  const { makeAgentService } = await import("./AgentService.ts");
  const { workspaceLayout, leaseToolRuntime } = await import("@paws/runtime");
  const { realpath } = await import("node:fs/promises");
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-host-attachments-");
  const service = makeAgentService(root);

  try {
    const agent = await Effect.runPromise(service.create({ name: "Host" }));
    const layout = workspaceLayout(root, agent.id);
    const lease = await leaseToolRuntime(root, agent.id);
    let canonical: string;

    try {
      canonical = (
        await lease.execute("pwd -P", new AbortController().signal)
      ).trim();
    } finally {
      await lease.dispose();
    }

    expect(canonical).toBe(await realpath(layout.workspace));
    await writeFile(`${layout.workspace}/report.txt`, "report");

    for (const path of [
      "report.txt",
      `${layout.workspace}/report.txt`,
      `${canonical}/report.txt`,
    ]) {
      expect(
        await saveWorkspaceAttachments(root, agent.id, [{ path }]),
      ).toMatchObject([{ name: "report.txt", size: 6 }]);
    }

    await writeFile(`${root}/private`, "private");
    await symlink(`${root}/private`, `${canonical}/escape`);
    await mkdir(`${canonical}-other`);
    await writeFile(`${canonical}-other/report.txt`, "outside");

    for (const path of [
      `${root}/private`,
      `${canonical}-other/report.txt`,
      `${layout.workspace}/escape`,
      `${canonical}/escape`,
      `${canonical}/../../../private`,
    ]) {
      await expect(
        saveWorkspaceAttachments(root, agent.id, [{ path }]),
      ).rejects.toThrow();
    }
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["sandbox", "team"])(
  "keeps %s attachment paths inside the advertised container workspace",
  async (kind) => {
    const { Effect } = await import("effect");
    const { makeAgentService } = await import("./AgentService.ts");
    const { workspaceLayout } = await import("@paws/runtime");
    const { realpath } = await import("node:fs/promises");
    await mkdir("/tmp/codex", { recursive: true });
    const root = await mkdtemp("/tmp/codex/paws-container-attachments-");
    const service = makeAgentService(root);

    try {
      const team =
        kind === "team"
          ? await Effect.runPromise(
              service.saveTeam({ name: "Team", memory: "" }),
            )
          : null;
      const agent = await Effect.runPromise(
        service.create({
          name: "Agent",
          teamId: team?.id,
          sandbox: kind === "sandbox",
        }),
      );
      const workspace = workspaceLayout(root, agent.id).workspace;
      const canonical = await realpath(workspace);
      const virtual = team
        ? `/team/agents/${agent.id}/workspace`
        : "/agent/workspace";
      await writeFile(`${workspace}/report.txt`, "report");
      expect(
        await saveWorkspaceAttachments(root, agent.id, [
          { path: `${virtual}/report.txt` },
        ]),
      ).toMatchObject([{ name: "report.txt", size: 6 }]);

      for (const path of [
        `${workspace}/report.txt`,
        `${canonical}/report.txt`,
      ]) {
        await expect(
          saveWorkspaceAttachments(root, agent.id, [{ path }]),
        ).rejects.toThrow();
      }
    } finally {
      service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
