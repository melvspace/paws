import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import type { ChatTurn } from "@paws/provider-core";
import type { ProviderSnapshot } from "@paws/contracts";
import { makeAgentService } from "./AgentService.ts";
import { makeCodexChatRunner } from "./codexChatRunner.ts";

it("retains conversation processes, isolates routines, and closes cancelled and invalidated sessions", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-codex-runner-");
  const home = `${root}/provider-home`;
  const binary = `${root}/codex`;
  await mkdir(home);
  await writeFile(
    `${home}/auth.json`,
    JSON.stringify({
      tokens: { access_token: "fixture", account_id: "fixture" },
    }),
  );
  await writeFile(
    binary,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!m.id) continue;
  if (m.method === 'turn/start') {
    count++;
    send({ id: m.id, result: { turn: { id: String(count) } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'answer', delta: process.pid + ':' + count } });
    if (m.params.input[0]?.text !== 'wait') {
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: String(count), status: 'completed' } } });
    }
  } else {
    send({ id: m.id, result: m.method.startsWith('thread/') ? { thread: { id: 'thread' } } : {} });
  }
}
`,
    { mode: 0o700 },
  );
  const provider: ProviderSnapshot = {
    config: {
      id: "codex",
      driver: "codex",
      name: "Codex",
      enabled: true,
      binaryPath: binary,
      homePath: home,
      args: [],
    },
    status: "ready",
    auth: "authenticated",
    version: null,
    message: null,
    checkedAt: null,
    models: [],
  };
  const runner = makeCodexChatRunner(root, {
    list: () => [provider],
    environment: () => ({}),
  });
  const agents = makeAgentService(
    root,
    () => true,
    (id) => runner.closeAgent(id),
  );
  const results: string[] = [];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch {
      return false;
    }
  };

  try {
    const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
    const turn: ChatTurn = {
      agentId: agent.id,
      agentName: "Ada",
      nativeThreadId: null,
      text: "Authenticate",
      selection: { providerId: "codex", modelId: "model", options: {} },
      signal: AbortSignal.timeout(5000),
      onThread() {},
      onMessage() {},
      onText(_id, text) {
        results.push(text);
      },
    };
    await runner(turn);
    const pid = Number(results.at(-1)!.split(":")[0]);
    expect(alive(pid)).toBe(true);
    await runner({ ...turn, nativeThreadId: "thread", text: "Allowed" });
    expect(results.at(-1)).toBe(`${pid}:2`);
    await runner({ ...turn, conversationId: "routine-run" });
    const routinePid = Number(results.at(-1)!.split(":")[0]);
    expect(routinePid).not.toBe(pid);
    expect(alive(routinePid)).toBe(false);
    await runner({ ...turn, nativeThreadId: "thread" });
    expect(results.at(-1)).toBe(`${pid}:3`);
    const team = await Effect.runPromise(agents.saveTeam({ name: "Team" }));
    await Effect.runPromise(
      agents.moveTeam(agent.id, { fromTeamId: null, toTeamId: team!.id }),
    );
    expect(alive(pid)).toBe(false);
    expect(alive(routinePid)).toBe(false);
    // Move back to the host so the test never needs a live Docker daemon.
    await Effect.runPromise(
      agents.moveTeam(agent.id, { fromTeamId: team!.id, toTeamId: null }),
    );
    const abort = new AbortController();
    let cancelledPid = 0;
    await expect(
      runner({
        ...turn,
        text: "wait",
        signal: abort.signal,
        onText(_id, text) {
          cancelledPid = Number(text.split(":")[0]);
          abort.abort();
        },
      }),
    ).rejects.toThrow();
    expect(alive(cancelledPid)).toBe(false);
    await runner({ ...turn, nativeThreadId: "thread" });
    const resumedPid = Number(results.at(-1)!.split(":")[0]);
    expect(resumedPid).not.toBe(cancelledPid);
    expect(alive(resumedPid)).toBe(true);
    await runner.close();
    expect(alive(resumedPid)).toBe(false);
  } finally {
    await runner.close();
    agents.close();
    await rm(root, { recursive: true, force: true });
  }
});
