import { Effect, Schema } from "effect";
import { AgentManagementRequest, type Agent } from "@paws/contracts";
import { ChatToolError } from "@paws/provider-core";
import { AgentSettingsError, type makeAgentService } from "./AgentService.ts";
import { ChatError, type makeChatService } from "./ChatService.ts";

export function makeAgentManagementService(
  agents: ReturnType<typeof makeAgentService>,
  chat: ReturnType<typeof makeChatService>,
  idle: (id: string) => boolean,
  invalidate: (id: string) => void,
  onChange: () => void,
) {
  const execute = Effect.fn("AgentManagementService.execute")(
    (actor: string, value: unknown, allowChanges: boolean) =>
      Effect.tryPromise(async () => {
        const input = Schema.decodeUnknownSync(AgentManagementRequest, {
          onExcessProperty: "error",
        })(value);
        const roster = await Effect.runPromise(agents.list());

        if (!roster.some((agent) => agent.id === actor))
          throw new ChatError(404, "Agent not found.");
        if (input.action !== "read" && !allowChanges)
          throw new ChatError(
            403,
            "Agent configuration requires a direct user conversation. Peer messages and routines cannot authorize changes.",
          );

        const current =
          input.action === "create"
            ? undefined
            : roster.find((agent) => agent.id === (input.agentId ?? actor));

        if (input.action !== "create" && !current)
          throw new ChatError(404, "Agent not found.");

        if (input.action === "read")
          return {
            agent: profile(current!),
            selection: chat.get(current!.id).selection,
          };

        if (input.action === "create" && input.agentId)
          throw new ChatError(
            400,
            "New agents receive a server-assigned identity.",
          );
        if (input.selection) chat.validateSelection(input.selection);
        if (
          current &&
          (input.selection || input.sandbox !== undefined) &&
          !idle(current.id)
        )
          throw new ChatError(
            409,
            "Configure the environment or model while the agent is idle.",
          );

        const settings = {
          name: input.name ?? current?.name ?? "",
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
        };
        const changesEnvironment =
          current &&
          input.sandbox !== undefined &&
          input.sandbox !== current.sandbox;
        const configure =
          current && (input.selection || changesEnvironment)
            ? (agent: Agent) => {
                if (changesEnvironment) invalidate(agent.id);
                if (input.selection)
                  chat.setSelection(agent.id, input.selection);
              }
            : undefined;
        const result = await Effect.runPromise(
          Effect.result(
            current
              ? agents.update(current.id, settings, configure)
              : agents.create(settings),
          ),
        );

        if (result._tag === "Failure") {
          const cause = result.failure.cause;

          throw new ChatError(
            400,
            cause instanceof AgentSettingsError
              ? cause.message
              : "Check the agent settings.",
          );
        }

        const agent = result.success;

        if (!agent) throw new ChatError(404, "Agent not found.");
        if (input.selection && !current)
          chat.setSelection(agent.id, input.selection);

        onChange();

        return {
          agent: profile(agent),
          selection: chat.get(agent.id).selection,
        };
      }),
  );

  function profile(agent: Agent) {
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role ?? "",
      description: agent.description ?? "",
      sandbox: agent.sandbox ?? false,
      teamId: agent.teamId ?? null,
    };
  }

  return {
    execute,
    async tool(actor: string, value: unknown, allowChanges: boolean) {
      const result = await Effect.runPromise(
        Effect.result(execute(actor, value, allowChanges)),
      );

      if (result._tag === "Failure")
        throw new ChatToolError(
          result.failure.cause instanceof ChatError
            ? result.failure.cause.message
            : "Check agent management fields and required text.",
        );

      return result.success;
    },
  };
}
