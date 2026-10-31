import { probeOpenCodeProtocol } from "./openCodeProtocol.ts";
import { join } from "node:path";
import { z } from "zod";
import { openEventStream } from "./eventStream.ts";
import { randomBytes } from "node:crypto";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { OpenCode } from "@opencode/client";
import {
  chatInstructions,
  ChatExecutionError,
  type ChatTurn,
} from "@paws/provider-core";
import { withProcess, type ProbeLaunch } from "@paws/provider-core/process";
import { openToolBridge } from "./toolBridge.ts";
import {
  interactionText,
  nativePrompt,
  type ChatToolRuntime,
} from "./chatTools.ts";

export async function runOpenCodeTurn(
  launch: ProbeLaunch,
  turn: ChatTurn,
  runtime: ChatToolRuntime,
) {
  const bridge = await openToolBridge(turn, runtime);
  const password = randomBytes(32).toString("hex");
  const headers = {
    Connection: "close",
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  };
  const config = {
    plugin: [],
    mcp: {
      paws: {
        type: "remote",
        url: bridge.url,
        headers: { Authorization: `Bearer ${bridge.token}` },
        oauth: false,
      },
    },
    permission: { "*": "ask", "paws_*": "allow" },
  };

  try {
    await withProcess(
      {
        ...launch,
        args: [...launch.args, "serve", "--hostname=127.0.0.1", "--port=0"],
        env: {
          ...launch.env,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_PASSWORD: password,
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          XDG_CONFIG_HOME: join(launch.cwd, "config"),
          OPENCODE_CONFIG_DIR: join(launch.cwd, "config", "opencode"),
          OPENCODE_DISABLE_CLAUDE_CODE: "true",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
        },
      },
      async (child, failure) => {
        const ready = new Promise<string>((resolve, reject) => {
          let output = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (text: string) => {
            output = (output + text).slice(-65536);
            const match =
              /server listening on\s+(http:\/\/127\.0\.0\.1:\d+)/i.exec(output);

            if (match) resolve(match[1]!);
          });
          child.once("close", () => reject(new Error("OpenCode exited")));
        });
        const baseUrl = await Promise.race([ready, failure]);
        const protocol = await probeOpenCodeProtocol(
          baseUrl,
          headers,
          turn.signal,
        );
        const slash = turn.selection.modelId.indexOf("/");

        if (slash < 1)
          throw new ChatExecutionError("Choose a valid OpenCode model.");

        const model = {
          providerID: turn.selection.modelId.slice(0, slash),
          modelID: turn.selection.modelId.slice(slash + 1),
        };
        const text = nativePrompt(turn, await interactionText(turn, runtime));
        const eventsAbort = new AbortController();
        const signal = AbortSignal.any([turn.signal, eventsAbort.signal]);

        if (protocol.generation === "v2") {
          const client = OpenCode.make({ baseUrl, headers });
          const sessionID =
            turn.nativeThreadId ??
            (
              await client.session.create(
                {
                  title: "Paws",
                  location: { directory: launch.cwd },
                  model: {
                    providerID: model.providerID,
                    id: model.modelID,
                    ...(turn.selection.options.variant
                      ? { variant: turn.selection.options.variant }
                      : {}),
                  },
                  permissions: [
                    { action: "*", resource: "*", effect: "ask" },
                    { action: "paws_*", resource: "*", effect: "allow" },
                  ],
                },
                { signal },
              )
            ).id;
          if (turn.nativeThreadId)
            await client.session.switchModel(
              {
                sessionID,
                model: {
                  providerID: model.providerID,
                  id: model.modelID,
                  ...(turn.selection.options.variant
                    ? { variant: turn.selection.options.variant }
                    : {}),
                },
              },
              { signal },
            );

          turn.onThread(sessionID);
          await client.mcp.add(
            {
              server: "paws",
              location: { directory: launch.cwd },
              config: {
                type: "remote",
                url: bridge.url,
                headers: { Authorization: `Bearer ${bridge.token}` },
                oauth: false,
              },
            },
            { signal },
          );
          await client.session.instructions.entry.put(
            { sessionID, key: "paws", value: chatInstructions(turn.agentName) },
            { signal },
          );
          const texts = new Map<string, string>();
          let resolveDone = () => {};
          const done = new Promise<void>((resolve) => {
            resolveDone = resolve;
          });
          const listen = (async () => {
            for await (const event of client.event.subscribe({ signal })) {
              if (
                !("sessionID" in event.data) ||
                event.data.sessionID !== sessionID
              )
                continue;

              if (
                event.type === "session.text.delta" ||
                event.type === "session.text.ended"
              ) {
                const id = `${event.data.assistantMessageID}:${event.data.ordinal}`;
                const value =
                  event.type === "session.text.delta"
                    ? (texts.get(id) ?? "") + event.data.delta
                    : event.data.text;
                texts.set(id, value);
                turn.onText(id, value, event.type === "session.text.ended");
              } else if (event.type === "permission.asked") {
                await client.permission.reply(
                  {
                    sessionID,
                    requestID: event.data.id,
                    decision: "reject",
                    message: "Use Paws container tools instead.",
                  },
                  { signal },
                );
              } else if (event.type === "session.execution.succeeded") {
                resolveDone();
              } else if (event.type === "session.execution.failed") {
                throw new ChatExecutionError(
                  "OpenCode could not finish this reply. Check its provider connection.",
                );
              }
            }

            if (!signal.aborted)
              throw new Error("OpenCode event stream closed");
          })();
          void listen.catch(() => {});

          try {
            if (turn.operation === "compact")
              await client.session.compact({ sessionID }, { signal });
            else await client.session.prompt({ sessionID, text }, { signal });

            await Promise.race([done, listen]);
          } finally {
            eventsAbort.abort();
            await listen.catch(() => {});
          }
        } else {
          const client = createOpencodeClient({
            baseUrl,
            headers,
            directory: launch.cwd,
          });
          const sessionID =
            turn.nativeThreadId ??
            (
              await client.session.create(
                {
                  title: "Paws",
                  permission: [
                    { permission: "*", pattern: "*", action: "ask" },
                    { permission: "paws_*", pattern: "*", action: "allow" },
                  ],
                },
                { signal, throwOnError: true },
              )
            ).data!.id;
          turn.onThread(sessionID);
          const eventUrl = new URL("/event", baseUrl);
          eventUrl.searchParams.set("directory", launch.cwd);
          const events = await openEventStream(eventUrl, headers, signal);
          const roles = new Map<string, string>();
          const pendingText = new Map<
            string,
            { messageID: string; text: string }
          >();
          const listen = (async () => {
            for await (const raw of events) {
              const event = z
                .object({ type: z.string(), properties: z.unknown() })
                .parse(raw);

              if (event.type === "message.updated") {
                const { info } = z
                  .object({
                    info: z.object({
                      id: z.string(),
                      sessionID: z.string(),
                      role: z.string(),
                    }),
                  })
                  .parse(event.properties);

                if (info.sessionID !== sessionID) continue;

                roles.set(info.id, info.role);

                if (info.role === "assistant") {
                  for (const [id, part] of pendingText) {
                    if (part.messageID === info.id) turn.onText(id, part.text);
                  }
                }
              } else if (event.type === "message.part.updated") {
                const { part } = z
                  .object({
                    part: z.object({
                      id: z.string(),
                      messageID: z.string(),
                      sessionID: z.string(),
                      type: z.string(),
                      text: z.string().optional(),
                    }),
                  })
                  .parse(event.properties);

                if (
                  part.sessionID !== sessionID ||
                  part.type !== "text" ||
                  part.text === undefined
                )
                  continue;

                pendingText.set(part.id, {
                  messageID: part.messageID,
                  text: part.text,
                });

                if (roles.get(part.messageID) === "assistant")
                  turn.onText(part.id, part.text);
              } else if (event.type === "permission.asked") {
                const permission = z
                  .object({ id: z.string(), sessionID: z.string() })
                  .parse(event.properties);

                if (permission.sessionID !== sessionID) continue;

                await client.permission.reply(
                  {
                    requestID: permission.id,
                    reply: "reject",
                    message: "Use Paws container tools instead.",
                  },
                  { signal, throwOnError: true },
                );
              }
            }

            if (!signal.aborted)
              throw new Error("OpenCode event stream closed");
          })();
          void listen.catch(() => {});

          try {
            if (turn.operation === "compact") {
              await client.session.summarize(
                { sessionID, ...model },
                { signal, throwOnError: true },
              );
            } else {
              const response = await Promise.race([
                client.session.prompt(
                  {
                    sessionID,
                    model,
                    ...(turn.selection.options.variant
                      ? { variant: turn.selection.options.variant }
                      : {}),
                    system: chatInstructions(turn.agentName),
                    parts: [{ type: "text", text }],
                  },
                  { signal, throwOnError: true },
                ),
                listen.then(() => {
                  throw new Error("OpenCode event stream closed");
                }),
              ]);

              if (response.data?.info.error)
                throw new ChatExecutionError(
                  "OpenCode could not finish this reply. Check its provider connection.",
                );

              for (const part of response.data?.parts ?? []) {
                if (part.type === "text") turn.onText(part.id, part.text, true);
              }
            }
          } finally {
            eventsAbort.abort();
            await listen.catch(() => {});
          }
        }
      },
    );
  } finally {
    await bridge.close();
  }
}
