import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { createCodexChatSession } from "./chat.ts";
import type { ChatTurn } from "@paws/provider-core";

it("keeps an interactive session alive between turns and uses current tool callbacks", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-live-session-");
  const script = `${root}/provider.mjs`;
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let terminal;
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === 'tool') {
    send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: String(count), status: 'completed' } } });
    continue;
  }
  if (!m.id) continue;
  if (m.method === 'turn/start') {
    count++;
    const text = terminal ? 'Approval received by existing terminal' : 'Open authorization';
    terminal = 'waiting-for-approval';
    send({ id: m.id, result: { turn: { id: String(count) } } });
    send({ id: 'tool', method: 'item/tool/call', params: { threadId: 'thread', callId: String(count), tool: 'paws_send_message', arguments: { text, actions: [], fields: [] } } });
  } else {
    send({ id: m.id, result: m.method.startsWith('thread/') ? { thread: { id: 'thread' } } : {} });
  }
}
`,
  );
  const controller = new AbortController();
  const session = createCodexChatSession({
    command: process.execPath,
    args: [script],
    cwd: root,
    signal: controller.signal,
  });
  const messages: string[] = [];
  const turn: ChatTurn = {
    agentId: "agent",
    agentName: "Agent",
    nativeThreadId: null,
    text: "Authenticate",
    selection: { providerId: "codex", modelId: "model", options: {} },
    signal: AbortSignal.timeout(3000),
    onThread() {},
    onText() {},
    onMessage(_id, card) {
      messages.push(`first: ${card.text}`);
    },
  };
  const credentials = async () => ({
    accessToken: "fixture",
    chatgptAccountId: "fixture",
    chatgptPlanType: null,
  });

  try {
    await session.run(turn, credentials);
    await session.run(
      {
        ...turn,
        nativeThreadId: "thread",
        text: "Allowed",
        onMessage(_id, card) {
          messages.push(`second: ${card.text}`);
        },
      },
      credentials,
    );
    expect(messages).toEqual([
      "first: Open authorization",
      "second: Approval received by existing terminal",
    ]);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
