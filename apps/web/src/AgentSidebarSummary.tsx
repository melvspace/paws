import {
  defaultAgentAvatar,
  type Agent,
  type Conversation,
} from "@paws/contracts";
import { AgentAvatar } from "./AgentAvatar.tsx";

export function AgentSidebarSummary({
  agent,
  conversation,
  animated,
}: {
  agent: Agent;
  conversation: Conversation | undefined;
  animated: boolean;
}) {
  const unread = conversation?.unreadCount ?? 0;
  const lastMessage = conversation?.messages.at(-1);
  const date = lastMessage ? new Date(lastMessage.createdAt) : null;
  const validDate = date && Number.isFinite(date.getTime()) ? date : null;
  const today = validDate?.toDateString() === new Date().toDateString();
  const preview =
    lastMessage?.text.trim().replace(/\s+/g, " ") ||
    (lastMessage?.attachments?.length ? "Attachment" : "");

  return (
    <>
      <span className="sidebar-agent-avatar">
        <AgentAvatar
          avatar={agent.avatar ?? defaultAgentAvatar(agent.id)}
          size={40}
          animated={animated}
          activity={
            conversation?.status === "running"
              ? "working"
              : (conversation?.status ?? "idle")
          }
        />
        {unread > 0 && (
          <span
            className="sidebar-unread"
            aria-label={`${unread} unread ${unread === 1 ? "message" : "messages"}`}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </span>
      <span className="sidebar-agent-copy">
        <span className="sidebar-agent-topline">
          <span className="sidebar-agent-name">{agent.name}</span>
          {validDate && (
            <time
              dateTime={validDate.toISOString()}
              title={validDate.toLocaleString()}
            >
              {validDate.toLocaleString(
                undefined,
                today
                  ? { hour: "numeric", minute: "2-digit" }
                  : {
                      month: "short",
                      day: "numeric",
                      ...(validDate.getFullYear() !== new Date().getFullYear()
                        ? ({ year: "numeric" } as const)
                        : {}),
                    },
              )}
            </time>
          )}
        </span>
        {preview && <span className="sidebar-agent-preview">{preview}</span>}
      </span>
    </>
  );
}
