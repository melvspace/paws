import { spawnMspConnection } from "@muse-code/sdk";
import { z } from "zod";
import {
  chatInstructions,
  ChatExecutionError,
  type ChatTurn,
} from "@paws/provider-core";
import type { ProbeLaunch } from "@paws/provider-core/process";
import { openToolBridge } from "./toolBridge.ts";
import { museContextUsage } from "./contextUsage.ts";
import {
  interactionText,
  nativePrompt,
  type ChatToolRuntime,
} from "./chatTools.ts";

// T3's MSP command IDs, session MCP setup, and early-completion handling.
export async function runMuseTurn(
  launch: ProbeLaunch,
  turn: ChatTurn,
  runtime: ChatToolRuntime,
) {
  const bridge = await openToolBridge(turn, runtime);
  const pending = spawnMspConnection({
    command: launch.command,
    args: [...launch.args, "serve", "--disable-shell", "--disable-write"],
    cwd: launch.cwd,
    env: { ...launch.env, MUSE_NO_AUTO_UPDATE: "1" },
    shutdownTimeoutMs: 1000,
  });
  const abort = () => {
    void pending.close();
  };
  turn.signal.addEventListener("abort", abort, { once: true });

  try {
    turn.signal.throwIfAborted();
    const host = await pending.initialize({
      clientInfo: { name: "paws", title: "Paws", version: "1" },
      capabilities: { requestedCapabilities: ["sessionMcp"] },
    });

    if (!host.initializeResult.grantedCapabilities.includes("sessionMcp"))
      throw new ChatExecutionError(
        "Update Muse Code to a version with session MCP support.",
      );

    const sessionId = turn.nativeThreadId ?? host.connection.mintCommandId();
    const turnId = host.connection.mintCommandId();
    let complete = () => {};
    let fail = (_error: unknown) => {};
    const done = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    void done.catch(() => {});
    let contextMaxTokens: number | null = null;
    host.connection.onNotification((notification) => {
      try {
        if (notification.method === "session/contextUsage") {
          const { sessionId: reportedSessionId } = z
            .object({ sessionId: z.string() })
            .parse(notification.params);

          if (reportedSessionId === sessionId) {
            const usage = museContextUsage(notification.params);
            contextMaxTokens = usage.maxTokens ?? contextMaxTokens;
            turn.onUsage?.({ ...usage, maxTokens: contextMaxTokens });
          }
        } else if (
          notification.method === "item/completed" ||
          notification.method === "item/updated"
        ) {
          const data = z
            .object({
              sessionId: z.string(),
              item: z.object({
                itemId: z.string(),
                turnId: z.string().optional(),
                kind: z.string(),
                text: z.string().optional(),
                retracted: z.boolean().optional(),
              }),
            })
            .parse(notification.params);

          if (
            data.sessionId === sessionId &&
            data.item.turnId === turnId &&
            data.item.kind === "agentMessage" &&
            !data.item.retracted
          )
            turn.onText(
              data.item.itemId,
              data.item.text ?? "",
              notification.method === "item/completed",
            );
        } else if (notification.method === "turn/completed") {
          const data = z
            .object({
              sessionId: z.string(),
              turnId: z.string(),
              terminal: z.string(),
            })
            .parse(notification.params);

          if (data.sessionId !== sessionId || data.turnId !== turnId) return;

          if (data.terminal === "completed") complete();
          else
            fail(
              new ChatExecutionError(
                "Muse could not finish this reply. Check its connection in Providers.",
              ),
            );
        } else if (notification.method === "userInput/requested") {
          const data = z
            .object({ sessionId: z.string(), userInputId: z.string() })
            .parse(notification.params);

          if (data.sessionId === sessionId)
            void host.connection
              .command("userInput/cancel", {
                sessionId,
                userInputId: data.userInputId,
                reason: "Use Paws interactive message tools to request input.",
              })
              .catch(fail);
        } else if (notification.method === "approval/requested") {
          const data = z
            .object({
              sessionId: z.string(),
              approvalId: z.string(),
              currentRequirementId: z.unknown(),
              availableChoices: z.array(
                z.object({ choiceId: z.string(), decision: z.string() }),
              ),
            })
            .parse(notification.params);
          const deny = data.availableChoices.find(
            (choice) => choice.decision === "denied",
          );

          if (data.sessionId === sessionId && deny)
            void host.connection
              .command("approval/decide", {
                sessionId,
                approvalId: data.approvalId,
                requirementId: data.currentRequirementId,
                choiceId: deny.choiceId,
              })
              .catch(fail);
        }
      } catch (error) {
        fail(error);
      }
    });
    host.connection.onProtocolError(fail);
    void host.connection.closed.then(() =>
      fail(new Error("Muse connection closed")),
    );
    const config = {
      mcpServers: {
        paws: {
          transport: "streamableHttp",
          mode: "optional",
          url: bridge.url,
          headers: { Authorization: `Bearer ${bridge.token}` },
        },
      },
    };
    const started = z
      .object({ session: z.object({ sessionId: z.string() }) })
      .parse(
        await host.connection.command(
          turn.nativeThreadId ? "session/resume" : "session/start",
          {
            sessionId,
            config,
            permissionProfile: ":ask-me",
            ...(turn.nativeThreadId
              ? { excludeItems: true }
              : {
                  workspaceRoot: launch.cwd,
                  providerId: "meta",
                  ...(turn.selection.modelId !== "default"
                    ? { modelId: turn.selection.modelId }
                    : {}),
                  approvalMode: "denyUnmatched",
                }),
          },
        ),
      );
    turn.onThread(started.session.sessionId);
    await host.connection.command("session/setApprovalMode", {
      sessionId,
      mode: "denyUnmatched",
    });

    if (turn.selection.modelId !== "default")
      await host.connection.command("session/setModel", {
        sessionId,
        modelId: turn.selection.modelId,
        providerId: "meta",
      });

    const result = await host.connection.command(
      turn.operation === "compact" ? "session/compact" : "turn/start",
      {
        sessionId,
        ...(turn.operation === "compact"
          ? {}
          : {
              input: [
                {
                  type: "text",
                  text: `${chatInstructions(turn.agentName)}\n\n${nativePrompt(turn, await interactionText(turn, runtime))}`,
                },
              ],
              displayText: turn.text,
              workspaceRoots: [launch.cwd],
              ifBusy: "queue",
              ...(turn.selection.options.reasoningEffort
                ? { reasoningEffort: turn.selection.options.reasoningEffort }
                : {}),
            }),
      },
      { commandId: turnId, maxAttempts: 1 },
    );
    if (turn.operation === "compact") {
      const compact = z.object({ status: z.string() }).parse(result);

      if (compact.status === "noop")
        throw new ChatExecutionError("Muse has no context to compact yet.");

      if (compact.status !== "accepted")
        throw new Error("Unexpected Muse compaction status");
    }

    await done;
  } finally {
    turn.signal.removeEventListener("abort", abort);
    await pending.close();
    await bridge.close();
  }
}
