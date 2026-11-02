import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { runCodexTurn } from "./chat.ts";

it("starts and resumes threads, translates options and handles dynamic tools and early completion", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-chat-protocol-");
  const script = `${root}/provider.mjs`;
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method) appendFileSync(${JSON.stringify(`${root}/requests`)}, JSON.stringify(m.method==='account/login/start'?{method:m.method}:m)+'\\n');
 if(m.id==='tool') {
  if (!m.result?.success) process.exit(9);
  send({method:'item/agentMessage/delta',params:{threadId:'thread',itemId:'answer',delta:'Done'}});
  send({method:'item/started',params:{threadId:'thread',item:{id:'image',type:'imageGeneration'}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});
  send({id:'4',result:{turn:{id:'turn'}}});
  setTimeout(() => send({method:'item/completed',params:{threadId:'thread',item:{id:'image',type:'imageGeneration',status:'completed',failure:null,savedPath:'/home/agent/.codex/generated_images/thread/image.png',result:'x'.repeat(5*1024*1024)}}}), 30);
  continue;
 }
 if(m.method==='initialized') continue;
 if(m.method==='thread/compact/start') {
  send({id:m.id,result:{}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{last:{totalTokens:2000},total:{totalTokens:900000},modelContextWindow:258000}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});
  continue;
 }
 if(m.method==='turn/start') {
  send({method:'item/agentMessage/delta',params:{threadId:'other',itemId:'wrong',delta:'Ignore'}});
  const secret = m.params.toolOutput && JSON.parse(m.params.toolOutput.output).type === 'secret_saved';
  send({id:'tool',method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'card',tool:secret?'request_secret':'paws_send_message',arguments:secret?{label:'Token',reason:'Connect service'}:{text:'Choose',actions:[{id:'yes',label:'Yes'}],fields:[],attachments:[{path:'/workspace/video.mp4'}]}}});
  continue;
 }
 send({id:m.id,result:m.method?.startsWith('thread/')?{thread:{id:'thread'}}:{}});
}
`,
  );
  const received: string[] = [];
  const images: string[] = [];
  const usage: number[] = [];
  const secretRequests: string[] = [];
  const deliveries: string[] = [];

  try {
    for (const operation of [
      "new",
      "resume",
      "compact",
      "interaction",
      "secret",
    ]) {
      const nativeThreadId = operation === "new" ? null : "thread";
      await runCodexTurn(
        {
          command: process.execPath,
          args: [script],
          cwd: root,
          signal: AbortSignal.timeout(3000),
        },
        {
          agentId: "agent",
          ...(operation === "compact" ? { operation: "compact" as const } : {}),
          onUsage: (value) => usage.push(value.usedTokens),
          agentName: "Ada",
          nativeThreadId,
          text: "Hello",
          ...(operation === "resume"
            ? { handoff: "Historical reply from Claude" }
            : {}),
          ...(operation === "interaction"
            ? {
                interaction: {
                  source: "paws" as const,
                  type: "action_clicked" as const,
                  eventId: "event",
                  messageId: "message",
                  prompt: "Choose",
                  action: { id: "yes", label: "Yes" },
                  fields: [],
                },
              }
            : {}),
          ...(operation === "secret"
            ? {
                interaction: {
                  source: "paws" as const,
                  type: "secret_saved" as const,
                  eventId: "secret-event",
                  messageId: "secret-message",
                  prompt: "Connect service",
                  action: { id: "save", label: "Token" },
                  fields: [],
                  secretRef: "private-reference",
                },
              }
            : {}),
          selection: {
            providerId: "codex",
            modelId: "model",
            options: { reasoningEffort: "high", serviceTier: "fast" },
          },
          signal: AbortSignal.timeout(3000),
          onImage: async (_id, path) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            images.push(path);
          },
          onThread: (id) => received.push(id),
          onText: (_id, text) => received.push(text),
          onMessage: async (_id, card, attachments) => {
            if (!card.secretRequest)
              expect(attachments).toEqual([{ path: "/workspace/video.mp4" }]);

            await Promise.resolve();
            received.push(card.text);

            if (card.secretRequest)
              secretRequests.push(card.secretRequest.label);
          },
        },
        async () => ({
          accessToken: "secret",
          chatgptAccountId: "account",
          chatgptPlanType: null,
        }),
        async (reference) => {
          deliveries.push(reference);

          return "/tmp/paws-secrets/private-file";
        },
      );
    }

    expect(usage).toEqual([2000]);
    expect(images).toHaveLength(4);
    expect(secretRequests).toEqual(["Token"]);
    expect(deliveries).toEqual(["private-reference"]);
    expect(images[0]).toContain("generated_images/thread/image.png");
    expect(received).toEqual([
      "thread",
      "Choose",
      "Done",
      "thread",
      "Choose",
      "Done",
      "thread",
      "thread",
      "Choose",
      "Done",
      "thread",
      "Connect service",
      "Done",
    ]);
    const requests = (await readFile(`${root}/requests`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const start = requests.find((item) => item.method === "thread/start");
    expect(start.params.cwd).toBe("/workspace");
    expect(start.params.dynamicTools[0].name).toBe("paws_send_message");
    expect(
      requests.find((item) => item.method === "thread/resume").params.threadId,
    ).toBe("thread");
    expect(
      requests.find((item) => item.method === "turn/start").params,
    ).toMatchObject({ effort: "high", serviceTier: "fast", model: "model" });
    const handoffTurn = requests.find((item) => item.params?.additionalContext);
    expect(handoffTurn.params.additionalContext).toEqual({
      paws_handoff: {
        kind: "untrusted",
        value: "Historical reply from Claude",
      },
    });
    expect(handoffTurn.params.input).toEqual([
      { type: "text", text: "Hello", text_elements: [] },
    ]);
    const eventTurn = requests.find((item) => item.params?.toolOutput);
    expect(eventTurn.params.input).toEqual([]);
    expect(eventTurn.params.toolOutput).toMatchObject({
      name: "paws_interaction",
      retain: true,
    });
    expect(JSON.parse(eventTurn.params.toolOutput.output)).toMatchObject({
      source: "paws",
      type: "action_clicked",
      action: { id: "yes", label: "Yes" },
    });
    const secretTurn = requests
      .filter((item) => item.method === "turn/start")
      .at(-1);
    expect(secretTurn.params.input).toEqual([]);
    expect(JSON.parse(secretTurn.params.toolOutput.output)).toMatchObject({
      type: "secret_saved",
      file: "/tmp/paws-secrets/private-file",
    });
    expect(secretTurn.params.toolOutput.output).not.toContain(
      "private-reference",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("resolves attachments to workspace metadata through the native tool", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-image-tool-");
  const script = `${root}/provider.mjs`;
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line);
  if (m.id === 'image-tool') {
    if (JSON.parse(m.result?.contentItems?.[0]?.text ?? '{}').path !== '/workspace/clip.mp4') process.exit(9);
    send({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});
    continue;
  }
  if (m.method === 'initialized') continue;
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    send({id:'image-tool',method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'image',tool:'paws_read_attachment',arguments:{id:'image'}}});
    continue;
  }
  send({id:m.id,result:m.method?.startsWith('thread/') ? {thread:{id:'thread'}} : {}});
}
`,
  );

  try {
    await runCodexTurn(
      {
        command: process.execPath,
        args: [script],
        cwd: root,
        signal: AbortSignal.timeout(3000),
      },
      {
        agentId: "agent",
        agentName: "Ada",
        nativeThreadId: null,
        text: "View image",
        selection: { providerId: "codex", modelId: "model", options: {} },
        signal: AbortSignal.timeout(3000),
        onThread() {},
        onText() {},
        onMessage() {},
        readAttachment: async () => ({
          path: "/workspace/clip.mp4",
          name: "clip.mp4",
          mediaType: "video/mp4",
          size: 42,
        }),
      },
      async () => ({
        accessToken: "test",
        chatgptAccountId: "test",
        chatgptPlanType: null,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("advertises silent completion and validates its native tool arguments", async () => {
  const root = await mkdtemp("/tmp/codex/paws-silent-tool-");
  const script = `${root}/provider.mjs`;
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const call = (id, silent) => send({id,method:'item/tool/call',params:{threadId:'thread',callId:id,tool:'paws_finish_turn',arguments:{silent}}});
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line);
  if(m.id === 'invalid') {
    if(m.result?.success !== false) process.exit(9);
    call('silent', true);
    continue;
  }
  if(m.id === 'silent') {
    if(m.result?.success !== true) process.exit(10);
    send({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});
    continue;
  }
  if(m.method === 'thread/start' && !m.params.dynamicTools.some(tool=>tool.name==='paws_finish_turn')) process.exit(11);
  if(m.method === 'initialized') continue;
  if(m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    call('invalid', false);
    continue;
  }
  send({id:m.id,result:m.method?.startsWith('thread/')?{thread:{id:'thread'}}:{}});
}
`,
  );
  const finished: unknown[] = [];

  try {
    await runCodexTurn(
      {
        command: process.execPath,
        args: [script],
        cwd: root,
        signal: AbortSignal.timeout(3000),
      },
      {
        agentId: "agent",
        agentName: "Ada",
        nativeThreadId: null,
        text: "Don't respond",
        selection: { providerId: "codex", modelId: "model", options: {} },
        signal: AbortSignal.timeout(3000),
        onThread() {},
        onText() {},
        onMessage() {},
        onFinish: (options) => {
          finished.push(options);
        },
      },
      async () => ({
        accessToken: "test",
        chatgptAccountId: "test",
        chatgptPlanType: null,
      }),
    );
    expect(finished).toEqual([{ silent: true }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves explicitly safe tool diagnostics and hides unexpected errors", async () => {
  const { ChatToolError } = await import("@paws/provider-core");
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-tool-diagnostics-");
  const script = `${root}/provider.mjs`;
  await writeFile(
    script,
    `
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.id==='tool') {
  writeFileSync(${JSON.stringify(`${root}/result`)},JSON.stringify(m.result));
  send({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});
 } else if(m.method==='initialized') continue;
 else if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({id:'tool',method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'call',tool:'paws_team_tool',arguments:{action:'start'}}});
 } else if(m.id) send({id:m.id,result:m.method?.startsWith('thread/')?{thread:{id:'thread'}}:{}});
}
`,
  );

  try {
    for (const error of [
      new ChatToolError("Container creation timed out; Docker is busy."),
      new Error("private-unexpected-value"),
    ]) {
      await runCodexTurn(
        {
          command: process.execPath,
          args: [script],
          cwd: root,
          signal: AbortSignal.timeout(3000),
        },
        {
          agentId: "agent",
          agentName: "Assistant",
          nativeThreadId: null,
          text: "Start login",
          selection: { providerId: "codex", modelId: "model", options: {} },
          signal: AbortSignal.timeout(3000),
          onThread() {},
          onText() {},
          onMessage() {},
          teamTool: async () => {
            throw error;
          },
        },
        async () => ({
          accessToken: "test",
          chatgptAccountId: "test",
          chatgptPlanType: null,
        }),
      );
      const result = JSON.parse(await readFile(`${root}/result`, "utf8"));
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain("private-unexpected-value");

      if (error instanceof ChatToolError)
        expect(JSON.stringify(result)).toContain(error.message);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
