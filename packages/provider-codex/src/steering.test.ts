import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import type { SteerChat } from "@paws/provider-core";
import { runCodexTurn } from "./chat.ts";

for (const mode of ["interaction", "text", "rejected"] as const) {
  it(`handles live ${mode} steering and completion races`, async () => {
    await mkdir("/tmp/codex", { recursive: true });
    const root = await mkdtemp("/tmp/codex/paws-steering-protocol-");
    await writeFile(
      `${root}/provider.mjs`,
      `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const complete = id => send({method:'turn/completed',params:{threadId:'thread',turn:{id,status:'completed'}}});
for await (const line of createInterface({input:process.stdin})) {
 const m = JSON.parse(line);
 if (!m.method || m.method==='initialized') continue;
 if (m.method==='turn/steer' || m.params?.toolOutput) {
  writeFileSync(${JSON.stringify(`${root}/steer`)},JSON.stringify(m));
  if (${JSON.stringify(mode)}==='rejected') {
   send({id:m.id,error:{code:-32602,message:'No active turn'}});
   complete('original');
  } else if(m.params.toolOutput) {
   complete('original');
   send({method:'turn/started',params:{threadId:'thread',turn:{id:'continued'}}});
   complete('continued');
   send({id:m.id,result:{turn:{id:'continued'}}});
  } else {
   send({id:m.id,result:{turnId:'original'}});
   complete('original');
  }
  continue;
 }
 if (m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'original'}}});
  send({method:'turn/started',params:{threadId:'thread',turn:{id:'original'}}});
  send({id:'card',method:'item/tool/call',params:{threadId:'thread',callId:'choice',tool:'paws_send_message',arguments:{text:'Choose',actions:[{id:'yes',label:'Yes'}],fields:[]}}});
  continue;
 }
 send({id:m.id,result:m.method==='thread/start'?{thread:{id:'thread'}}:{}});
}
`,
    );
    let steer: SteerChat | null = null;
    let delivery: Promise<"accepted" | "queue"> | undefined;

    try {
      await runCodexTurn(
        {
          command: process.execPath,
          args: [`${root}/provider.mjs`],
          cwd: root,
          signal: AbortSignal.timeout(3000),
        },
        {
          agentId: "agent",
          agentName: "Agent",
          nativeThreadId: null,
          text: "Start",
          selection: { providerId: "provider", modelId: "model", options: {} },
          signal: AbortSignal.timeout(3000),
          onThread() {},
          onText() {},
          onSteer(value) {
            steer = value;
          },
          onMessage() {
            delivery = steer!(
              mode === "text"
                ? { text: "Correction", requestId: "follow-up" }
                : {
                    interaction: {
                      source: "paws",
                      type: "action_clicked",
                      eventId: "event",
                      messageId: "choice",
                      prompt: "Choose",
                      action: { id: "yes", label: "Yes" },
                      fields: [],
                    },
                  },
            );
          },
        },
        async () => ({
          accessToken: "test",
          chatgptAccountId: "test",
          chatgptPlanType: null,
        }),
      );
      expect(await delivery).toBe(mode === "rejected" ? "queue" : "accepted");
      expect(steer).toBeNull();
      const request = JSON.parse(await readFile(`${root}/steer`, "utf8"));

      if (mode === "text") {
        expect(request.method).toBe("turn/steer");
        expect(request.params.expectedTurnId).toBe("original");
        expect(request.params.input[0].text).toBe("Correction");
      } else {
        expect(request.params.input).toEqual([]);
        expect(JSON.parse(request.params.toolOutput.output).source).toBe(
          "paws",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
