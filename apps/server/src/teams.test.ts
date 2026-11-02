import * as Fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { agentContext, memoryTool } from "./teamContext.ts";
import { listAgentSkills } from "./agentSkills.ts";
import { workspaceLayout } from "@paws/runtime";

it("persists one team, moves personal files, leaves shared files, and enforces idle reassignment", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-teams-");
  let idle = true;
  let service = makeAgentService(root, () => idle);

  try {
    const first = (await Effect.runPromise(
      service.saveTeam({ name: "A", memory: "Team A" }),
    ))!;
    const second = (await Effect.runPromise(
      service.saveTeam({ name: "B", memory: "Team B" }),
    ))!;
    const agent = await Effect.runPromise(
      service.create({ name: "Ada", teamId: first.id }),
    );
    const host = await Effect.runPromise(service.create({ name: "Host" }));
    expect(host).toMatchObject({ teamId: null, sandbox: false });
    expect(agentContext(root, agent.id).teams).toEqual([first]);
    const layout = workspaceLayout(root, agent.id);
    await Fs.writeFile(join(layout.workspace, "personal.txt"), "work");
    await Fs.writeFile(
      join(root, "teams", first.id, "files/shared.txt"),
      "shared",
    );
    memoryTool(root, agent.id, { memory: "Personal memory" });
    expect(() => memoryTool(root, host.id, { teamId: first.id })).toThrow(
      "Join",
    );
    await expect(
      Effect.runPromise(service.removeTeam(first.id)),
    ).rejects.toThrow();
    idle = false;
    await expect(
      Effect.runPromise(
        service.moveTeam(agent.id, {
          fromTeamId: first.id,
          toTeamId: second.id,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        service.update(host.id, { name: host.name, sandbox: true }),
      ),
    ).rejects.toThrow();
    idle = true;
    await expect(
      Effect.runPromise(
        service.moveTeam(agent.id, { fromTeamId: null, toTeamId: second.id }),
      ),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        service.moveTeam(agent.id, {
          fromTeamId: first.id,
          toTeamId: "missing",
        }),
      ),
    ).rejects.toThrow();
    await Effect.runPromise(
      service.moveTeam(agent.id, { fromTeamId: first.id, toTeamId: second.id }),
    );
    expect(
      await Fs.readFile(join(layout.workspace, "personal.txt"), "utf8"),
    ).toBe("work");
    expect(await Fs.realpath(layout.base)).toBe(
      join(root, "teams", second.id, "agents", agent.id),
    );
    expect(
      await Fs.readFile(
        join(root, "teams", first.id, "files/shared.txt"),
        "utf8",
      ),
    ).toBe("shared");
    expect(agentContext(root, agent.id)).toMatchObject({
      memory: "Personal memory",
      teams: [second],
    });
    await expect(
      Effect.runPromise(
        service.update(agent.id, { name: agent.name, sandbox: true }),
      ),
    ).rejects.toThrow();
    service.close();
    service = makeAgentService(root);
    expect((await Effect.runPromise(service.list()))[0]?.teamId).toBe(
      second.id,
    );
    await Effect.runPromise(
      service.moveTeam(agent.id, { fromTeamId: second.id, toTeamId: null }),
    );
    expect(await Fs.realpath(layout.base)).toBe(
      join(root, "standalone", agent.id),
    );
    expect(
      await Fs.readFile(join(layout.workspace, "personal.txt"), "utf8"),
    ).toBe("work");
    expect(await Effect.runPromise(service.removeTeam(first.id))).toBe(true);
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("discovers team and personal skills at paths inside the shared environment", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-team-skills-");
  const service = makeAgentService(root);

  try {
    const team = (await Effect.runPromise(
      service.saveTeam({ name: "A", memory: "" }),
    ))!;
    const agent = await Effect.runPromise(
      service.create({ name: "Ada", teamId: team.id }),
    );
    const layout = workspaceLayout(root, agent.id);

    for (const [directory, description] of [
      [join(root, "teams", team.id, "skills/writer"), "Shared"],
      [join(root, "teams", team.id, "skills/review"), "Review"],
      [join(layout.skills, "writer"), "Personal"],
    ]) {
      await Fs.mkdir(directory!, { recursive: true });
      await Fs.writeFile(
        join(directory!, "SKILL.md"),
        `---\nname: ${directory!.split("/").at(-1)}\ndescription: ${description}\n---\nInstructions`,
      );
    }

    expect(listAgentSkills(root, agent.id, team.id)).toEqual([
      {
        name: "review",
        description: "Review",
        path: "/team/skills/review/SKILL.md",
      },
      {
        name: "writer",
        description: "Personal",
        path: `/team/agents/${agent.id}/home/.agents/skills/writer/SKILL.md`,
      },
    ]);
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
