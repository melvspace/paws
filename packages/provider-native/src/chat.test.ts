import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import type { ChatTurn } from "@paws/provider-core";
import { runAcpTurn, containerPath } from "./acpChat.ts";
import { runPiTurn } from "./piChat.ts";
import { openToolBridge } from "./toolBridge.ts";

const makeTurn = (changes: Partial<ChatTurn> = {}): ChatTurn => ({
  agentId: "agent",
  agentName: "Ada",
  nativeThreadId: null,
  text: "Hello",
  handoff: "Previous conversation: calico cat",
  selection: { providerId: "provider", modelId: "vendor/model", options: {} },
  signal: AbortSignal.timeout(5000),
  onThread() {},
  onText() {},
  onMessage() {},
  ...changes,
});
const runtime = {
  execute: async () => "container output",
  deliverSecret: async () => "/tmp/paws-secrets/private",
};

it.each(["grok", "fx", "antigravity", "acpRegistry"] as const)(
  "%s starts/resumes ACP sessions, transfers history and routes file access to the container",
  async (driver) => {
    await mkdir("/tmp/codex", { recursive: true });
    const root = await mkdtemp("/tmp/codex/paws-acp-test-");
    const script = `${root}/provider.mjs`;
    await writeFile(
      script,
      `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let promptId;
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.id==='read') {
  if(m.result?.content !== 'container output') process.exit(5);
  send({id:'escape', method:'fs/read_text_file', params:{path:'/host/private'}});
  continue;
 }
 if(m.id==='escape') {
  if(!m.error) process.exit(6);
  send({method:'session/update', params:{sessionId:'other', update:{sessionUpdate:'usage_update',used:999,size:1000}}});
  send({method:'session/update', params:{sessionId:'session', update:{sessionUpdate:'usage_update',cost:{amount:1}}}});
  send({method:'session/update', params:{sessionId:'session', update:{sessionUpdate:'usage_update',used:1200,size:200000}}});
  send({method:'session/update', params:{sessionId:'session', update:{sessionUpdate:'state_update',state:'idle',usage:{totalTokens:1300}}}});
  send({method:'session/update', params:{sessionId:'session', update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello from ACP'}}}});
  send({id:promptId,result:{stopReason:'end_turn'}});
  continue;
 }
 appendFileSync(${JSON.stringify(`${root}/methods`)},m.method+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{agentCapabilities:{loadSession:true,mcpCapabilities:{http:true}}}});
 else if(m.method==='session/new'||m.method==='session/load') {
  const server=m.params.mcpServers[0];
  const response=await fetch(server.url,{method:'POST',headers:{Authorization:server.headers[0].value},body:JSON.stringify({id:1,method:'tools/call',params:{name:'paws_send_message',arguments:{text:'Choose',actions:[{id:'yes',label:'Yes'}]}}})});
  if(!(await response.json()).result) process.exit(7);
  send({id:m.id,result:{sessionId:'session'}});
 } else if(m.method==='session/prompt') {
  if(!m.params.prompt[0].text.includes('calico cat')) process.exit(8);
  promptId=m.id;
  send({id:'read',method:'fs/read_text_file',params:{path:m.params.cwd||'/workspace/notes.txt'}});
 } else send({id:m.id,result:{}});
}
`,
    );
    const texts: string[] = [];
    const cards: string[] = [];
    const commands: string[] = [];
    const usages: unknown[] = [];

    try {
      for (const nativeThreadId of [null, "session"]) {
        await runAcpTurn(
          {
            command: process.execPath,
            args: [script],
            cwd: root,
            signal: AbortSignal.timeout(5000),
          },
          makeTurn({
            nativeThreadId,
            onUsage: (usage) => usages.push(usage),
            onText: (_id, text) => texts.push(text),
            onMessage: (_id, card) => {
              cards.push(card.text);
            },
          }),
          {
            ...runtime,
            execute: async (command) => {
              commands.push(command);
              return "container output";
            },
          },
          driver,
        );
      }

      expect(texts).toEqual(["Hello from ACP", "Hello from ACP"]);
      expect(cards).toEqual(["Choose", "Choose"]);
      expect(usages).toEqual([
        { usedTokens: 1200, maxTokens: 200000 },
        { usedTokens: 1300, maxTokens: null },
        { usedTokens: 1200, maxTokens: 200000 },
        { usedTokens: 1300, maxTokens: null },
      ]);
      expect(commands).toEqual([
        "cat -- '/workspace/notes.txt'",
        "cat -- '/workspace/notes.txt'",
      ]);
      expect(await readFile(`${root}/methods`, "utf8")).toContain(
        "session/load",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("rejects host paths and traversal for ACP filesystem operations", () => {
  expect(containerPath("/control/a.txt", "/control")).toBe("/workspace/a.txt");
  expect(() => containerPath("/workspace/../private", "/control")).toThrow();
  expect(() => containerPath("/home/user/.claude", "/control")).toThrow();
});

it.each(["reported", "unsupported", "missing", "timeout", "compact"] as const)(
  "Pi reports context with %s stats, persists a session and disables ambient tools/extensions",
  async (scenario) => {
    const root = await mkdtemp("/tmp/codex/paws-pi-test-");
    const script = `${root}/provider.mjs`;
    await writeFile(
      script,
      `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
if(!process.argv.includes('--no-tools')||!process.argv.includes('--no-extensions')||!process.argv.includes('--extension')) process.exit(3);
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.type==='prompt') {
  if(!m.message.includes('calico cat')) process.exit(4);
  send({type:'message_start'});
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi reply'},message:{role:'assistant',usage:{totalTokens:1200}}});
  send({type:'agent_end'});
 }
 if(m.type==='get_session_stats' && ${JSON.stringify(scenario)}==='timeout') continue;
 const data=m.type==='set_model'?{contextWindow:200000}:m.type==='compact'?{estimatedTokensAfter:400}:m.type==='get_session_stats' && ${JSON.stringify(scenario)}!=='missing'?{contextUsage:{tokens:${scenario === "compact" ? "null" : "1300"},contextWindow:200000},tokens:{input:4000,output:1000}}:{};
 send({type:'response',id:m.id,command:m.type,success:m.type!=='get_session_stats'||${JSON.stringify(scenario)}!=='unsupported',data});
}
`,
    );
    const texts: string[] = [];
    let thread: string | null = null;
    const usages: unknown[] = [];

    try {
      await runPiTurn(
        {
          command: process.execPath,
          args: [script],
          cwd: root,
          signal: AbortSignal.timeout(3000),
        },
        makeTurn({
          ...(scenario === "compact" ? { operation: "compact" } : {}),
          onUsage: (usage) => usages.push(usage),
          onThread: (id) => {
            thread = id;
          },
          onText: (_id, text) => texts.push(text),
        }),
        runtime,
      );
      expect(thread).toMatch(/^[a-f0-9-]{36}$/);
      expect(texts).toEqual(scenario === "compact" ? [] : ["Pi reply"]);
      expect(usages).toEqual(
        scenario === "compact"
          ? [{ usedTokens: 400, maxTokens: 200000 }]
          : [
              { usedTokens: 1200, maxTokens: 200000 },
              ...(scenario === "reported"
                ? [{ usedTokens: 1300, maxTokens: 200000 }]
                : []),
            ],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("the tool bridge rejects browser and unauthenticated requests, validates forms and closes", async () => {
  const cards: string[] = [];
  const bridge = await openToolBridge(
    makeTurn({
      onMessage: (_id, card) => {
        cards.push(card.text);
      },
    }),
    runtime,
  );
  const body = JSON.stringify({
    id: 1,
    method: "tools/call",
    params: {
      name: "paws_send_message",
      arguments: { text: "Choose", actions: [{ id: "go", label: "Go" }] },
    },
  });

  try {
    expect((await fetch(bridge.url, { method: "POST", body })).status).toBe(
      403,
    );
    expect(
      (
        await fetch(bridge.url, {
          method: "POST",
          body,
          headers: {
            Authorization: `Bearer ${bridge.token}`,
            Origin: "https://untrusted.test",
          },
        })
      ).status,
    ).toBe(403);
    const response = await fetch(bridge.url, {
      method: "POST",
      body,
      headers: { Authorization: `Bearer ${bridge.token}` },
    });
    expect(await response.json()).toMatchObject({
      id: 1,
      result: { content: [{ type: "text" }] },
    });
    expect(cards).toEqual(["Choose"]);
  } finally {
    await bridge.close();
  }

  await expect(fetch(bridge.url)).rejects.toThrow();
});

it("resolves attachments to paths and views workspace images through separate harness tools", async () => {
  const id = "a".repeat(64);
  const bridge = await openToolBridge(
    makeTurn({
      readAttachment: async (input) => {
        if (input !== id) throw new Error("Not attached");

        return {
          path: "/workspace/clip.mp4",
          name: "clip.mp4",
          mediaType: "video/mp4",
        };
      },
      viewImage: async () => ({ mimeType: "image/png", data: "aW1hZ2U=" }),
    }),
    runtime,
  );

  try {
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "paws_read_attachment", arguments: { id } },
      }),
    });
    expect(await response.json()).toMatchObject({
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: "/workspace/clip.mp4",
              name: "clip.mp4",
              mediaType: "video/mp4",
            }),
          },
        ],
      },
    });
    const viewed = await fetch(bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "paws_view_image",
          arguments: { path: "/workspace/frame.png" },
        },
      }),
    });
    expect(await viewed.json()).toMatchObject({
      result: {
        content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      },
    });
  } finally {
    await bridge.close();
  }
});

it("offers silent completion through the shared MCP bridge and rejects invalid arguments", async () => {
  const finished: unknown[] = [];
  const bridge = await openToolBridge(
    makeTurn({
      onFinish: (options) => {
        finished.push(options);
      },
    }),
    runtime,
  );

  try {
    expect(bridge.tools.some((tool) => tool.name === "paws_finish_turn")).toBe(
      true,
    );

    for (const silent of [false, true]) {
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({
          id: 1,
          method: "tools/call",
          params: {
            name: "paws_finish_turn",
            arguments: { silent },
          },
        }),
      });
      const body = await response.json();

      if (silent)
        expect(body.result.content[0].text).toContain("finished silently");
      else expect(body.error).toBeDefined();
    }

    expect(finished).toEqual([{ silent: true }]);
  } finally {
    await bridge.close();
  }
});
