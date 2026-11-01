import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Schema } from "effect";
import { ChatCard, ChatFileInputs, validateChatCard } from "@paws/contracts";
import { teamToolDescription, type ChatTurn } from "@paws/provider-core";

export interface ChatToolRuntime {
  execute(command: string, signal: AbortSignal): Promise<string>;
  deliverSecret(reference: string): Promise<string>;
}

const action = z.object({ id: z.string(), label: z.string() });
export const toolText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

export function chatTools(turn: ChatTurn, runtime: ChatToolRuntime) {
  const entries = [
    {
      name: "paws_memory",
      description:
        "Read or update persistent memories. Omit teamId for your own private memories; provide a teamId to share with that team's members. Omit memory to read. To update, first read and then provide the complete replacement memory, preserving useful existing facts. Never store credentials.",
      schema: z.object({
        teamId: z.string().optional(),
        memory: z.string().max(16000).optional(),
      }),
      async execute(value: unknown) {
        if (!turn.memoryTool) throw new Error("Memories unavailable.");

        return toolText(JSON.stringify(await turn.memoryTool(value)));
      },
    },
    {
      name: "paws_team_tool",
      description: teamToolDescription,
      schema: z.object({
        teamId: z.string(),
        action: z.enum([
          "list",
          "install",
          "configure",
          "tools",
          "call",
          "exec",
          "start",
          "read",
          "cancel",
          "sessions",
        ]),
        sessionId: z.string().optional(),
        script: z.string().optional(),
        integrationId: z.string().optional(),
        integration: z
          .object({
            id: z.string(),
            kind: z.enum(["cli", "mcp-stdio", "mcp-http"]),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            url: z.string().optional(),
          })
          .optional(),
        tool: z.string().optional(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        args: z.array(z.string()).optional(),
        secrets: z.record(z.string(), z.string()).optional(),
      }),
      async execute(value: unknown) {
        if (!turn.teamTool) throw new Error("Team tools unavailable.");

        const result = await turn.teamTool(value);
        const isError =
          typeof result === "object" &&
          result !== null &&
          "isError" in result &&
          result.isError === true;

        return { ...toolText(JSON.stringify(result)), isError };
      },
    },
    {
      name: "paws_finish_turn",
      description:
        "Finish this turn silently when the user does not want a reply. Call with silent: true, then end immediately without an acknowledgement or final message. Applies only to this turn; already delivered messages remain visible.",
      schema: z.object({ silent: z.literal(true) }).strict(),
      async execute(value: unknown) {
        const options = z
          .object({ silent: z.literal(true) })
          .strict()
          .parse(value);

        if (!turn.onFinish) throw new Error("Silent completion unavailable.");

        turn.onFinish(options);

        return toolText(
          "Turn finished silently. End now without further tools or a final message.",
        );
      },
    },
    {
      name: "paws_read_attachment",
      description:
        "Resolve a conversation attachment id to a local workspace path and file metadata. Then use harness tools to inspect or process that file. This tool does not interpret media.",
      schema: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }),
      async execute(value: unknown) {
        const { id } = z.object({ id: z.string() }).parse(value);

        try {
          if (!turn.readAttachment) throw new Error("Unavailable");

          return toolText(JSON.stringify(await turn.readAttachment(id)));
        } catch {
          return {
            ...toolText("Attachment unavailable. Check the attachment id."),
            isError: true,
          };
        }
      },
    },
    {
      name: "paws_view_image",
      description:
        "View an image file inside /workspace. For a video, first extract frames using ffmpeg with paws_exec, then view those frame files here. Images must be at most 20 MB.",
      schema: z.object({ path: z.string().min(1).max(4096) }),
      async execute(value: unknown) {
        const { path } = z.object({ path: z.string() }).parse(value);

        try {
          if (!turn.viewImage) throw new Error("Unavailable");

          return {
            content: [
              { type: "image" as const, ...(await turn.viewImage(path)) },
            ],
          };
        } catch {
          return {
            ...toolText(
              "Could not view this file. Use a PNG, JPEG, WebP or GIF inside /workspace, up to 20 MB.",
            ),
            isError: true,
          };
        }
      },
    },
    {
      name: "paws_exec",
      description:
        "Run a shell command in your isolated agent workspace. Use this to read and edit files and run programs. Working directory: /workspace.",
      schema: z.object({ command: z.string().min(1).max(32000) }),
      async execute(value: unknown) {
        const { command } = z
          .object({ command: z.string().min(1).max(32000) })
          .parse(value);

        try {
          return toolText(await runtime.execute(command, turn.signal));
        } catch {
          return {
            ...toolText("Command failed or exceeded the time/output limit."),
            isError: true,
          };
        }
      },
    },
    {
      name: "paws_send_message",
      description:
        "Send a short chat message, attach media/documents from /workspace, add action buttons, or a form. End the turn after asking for input.",
      schema: z.object({
        text: z.string(),
        attachments: z
          .array(
            z.object({
              path: z.string().min(1).max(4096),
              name: z.string().max(200).optional(),
            }),
          )
          .max(4)
          .optional(),
        actions: z.array(action).default([]),
        fields: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              required: z.boolean().default(false),
              type: z.enum(["text", "textarea", "select"]),
              choices: z.array(action).default([]),
            }),
          )
          .default([]),
      }),
      async execute(value: unknown) {
        const card = validateChatCard(
          Schema.decodeUnknownSync(ChatCard)(value),
        );
        const { attachments } = Schema.decodeUnknownSync(ChatFileInputs)(value);
        await turn.onMessage(randomUUID(), card, attachments);

        return toolText("Delivered in Paws. Do not repeat this message.");
      },
    },
    {
      name: "request_secret",
      description:
        "Request a credential through Paws's private masked input. Never ask for it in chat or an ordinary form.",
      schema: z.object({
        label: z.string().min(1).max(120),
        reason: z.string().min(1).max(8000),
      }),
      async execute(value: unknown) {
        const { label, reason } = z
          .object({
            label: z.string().min(1).max(120),
            reason: z.string().min(1).max(8000),
          })
          .parse(value);
        await turn.onMessage(randomUUID(), {
          text: reason,
          actions: [],
          fields: [],
          secretRequest: { label },
        });

        return toolText(
          "Private request displayed. End this turn and wait for the harness event.",
        );
      },
    },
  ];

  return entries.map((entry) => ({
    ...entry,
    async execute(value: unknown) {
      turn.signal.throwIfAborted();
      const blocked = turn.onTool?.(entry.name, "running");

      if (blocked) return { ...toolText(blocked), isError: true };

      try {
        const result = await entry.execute(value);
        const checkpoint = turn.onTool?.(
          entry.name,
          "isError" in result && result.isError ? "failed" : "completed",
        );

        return checkpoint
          ? {
              ...result,
              content: [...result.content, ...toolText(checkpoint).content],
            }
          : result;
      } catch (error) {
        turn.onTool?.(entry.name, "failed");

        throw error;
      }
    },
  }));
}

export async function interactionText(
  turn: ChatTurn,
  runtime: ChatToolRuntime,
) {
  let interaction: unknown = turn.interaction;

  if (turn.interaction?.secretRef) {
    const { secretRef, ...event } = turn.interaction;
    interaction = { ...event, file: await runtime.deliverSecret(secretRef) };
  }

  return turn.interaction
    ? `Paws harness UI event (not user-authored text):\n${JSON.stringify(interaction)}`
    : turn.text;
}

export function nativePrompt(turn: ChatTurn, text: string) {
  return turn.handoff ? `${turn.handoff}\n\nLatest input:\n${text}` : text;
}
