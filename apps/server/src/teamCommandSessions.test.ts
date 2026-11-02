import * as Fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { teamTool } from "./teamIntegrations.ts";

it("returns an approval prompt before exit and resumes the same authentication session from a later teammate turn", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-command-session-");
  const service = makeAgentService(root);
  const originalPath = process.env.PATH;

  try {
    const team = await Effect.runPromise(
      service.saveTeam({ name: "Project", memory: "" }),
    );

    if (!team) throw new Error("Expected team.");

    const first = await Effect.runPromise(
      service.create({ name: "First", teamIds: [team.id] }),
    );
    const second = await Effect.runPromise(
      service.create({ name: "Second", teamIds: [team.id] }),
    );
    const signal = new AbortController();
    await teamTool(
      root,
      first.id,
      {
        teamId: team.id,
        action: "configure",
        integration: { id: "custom", kind: "cli", command: "custom-cli" },
        secrets: { SERVICE_TOKEN: "saved" },
      },
      signal.signal,
      () => "private-test-credential",
    );
    await Fs.writeFile(
      join(root, "docker"),
      `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify(args)+'\\n');
if (args[0] === 'inspect') {
  console.log(JSON.stringify({Status: existsSync(${JSON.stringify(join(root, "approved"))}) ? 'exited' : 'running', ExitCode:0}));
} else if (args[0] === 'logs') {
  console.log('Approve at https://example.test/device CODE-1234');
  console.log('private-test-credential');
  process.stdout.write('private-test-cred');
} else if (args[0] === 'create') {
  if (args.includes('--detach')) console.log('container-id');
  else console.log(existsSync(${JSON.stringify(join(root, "approved"))}) ? 'signed in' : 'not signed in');
}
`,
      { mode: 0o700 },
    );
    process.env.PATH = root;
    const start = JSON.parse(
      JSON.stringify(
        await teamTool(
          root,
          first.id,
          {
            teamId: team.id,
            integrationId: "custom",
            action: "start",
            args: ["login"],
          },
          signal.signal,
        ),
      ),
    );
    expect(start.status).toBe("running");
    expect(start.stdout).toContain("CODE-1234");
    expect(JSON.stringify(start)).not.toContain("private-test-credential");
    expect(start.stdout).not.toContain("private-test-cred");
    await teamTool(
      root,
      first.id,
      {
        teamId: team.id,
        action: "configure",
        integration: { id: "custom", kind: "cli", command: "custom-cli" },
        secrets: { SERVICE_TOKEN: "saved" },
      },
      new AbortController().signal,
      () => "rotated-test-credential",
    );
    signal.abort();
    const nextTurn = new AbortController().signal;
    const existing = JSON.parse(
      JSON.stringify(
        await teamTool(
          root,
          second.id,
          {
            teamId: team.id,
            integrationId: "custom",
            action: "start",
            args: ["login"],
          },
          nextTurn,
        ),
      ),
    );
    expect(existing.sessionId).toBe(start.sessionId);
    expect(existing.reused).toBe(true);
    await Fs.writeFile(join(root, "approved"), "yes");
    const finished = JSON.parse(
      JSON.stringify(
        await teamTool(
          root,
          second.id,
          {
            teamId: team.id,
            integrationId: "custom",
            action: "read",
            sessionId: start.sessionId,
          },
          nextTurn,
        ),
      ),
    );
    expect(finished.status).toBe("completed");
    expect(finished.exitCode).toBe(0);
    expect(JSON.stringify(finished)).not.toContain("private-test-credential");
    expect(finished.stdout).not.toContain("private-test-cred");
    const stored = await Fs.readFile(
      join(root, "runtime", "team-sessions", `${start.sessionId}.json`),
      "utf8",
    );
    expect(stored).not.toContain("private-test-credential");
    const repeat = await teamTool(
      root,
      second.id,
      {
        teamId: team.id,
        integrationId: "custom",
        action: "read",
        sessionId: start.sessionId,
      },
      nextTurn,
    );
    expect(repeat).toEqual(finished);
    const calls = (await Fs.readFile(join(root, "calls"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const runs = calls.filter((call: string[]) => call[0] === "create");
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toContain("--rm");
    expect(runs[0]).toContain(
      `type=bind,src=${join(root, "team-auth", team.id, "custom", "home")},dst=/home/agent`,
    );
    expect(runs[0].join(" ")).not.toContain("private-test-credential");
    expect(calls.at(-1)[0]).toBe("rm");
    await Effect.runPromise(
      service.update(second.id, { name: "Second", teamIds: [] }),
    );
    await expect(
      teamTool(
        root,
        second.id,
        {
          teamId: team.id,
          integrationId: "custom",
          action: "read",
          sessionId: start.sessionId,
        },
        nextTurn,
      ),
    ).rejects.toThrow("Join this team");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;

    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
