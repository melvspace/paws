import { useAtomValue } from "@effect/atom-react";
import { agentsAtom } from "@paws/client-runtime";
import {
  avatarColors,
  defaultAgentAvatar,
  type ChatMessage,
} from "@paws/contracts";
import { ChevronDownIcon } from "lucide-react";
import { AgentAvatar } from "../AgentAvatar.tsx";
import { MessageAttachment } from "./MessageAttachment.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { messageTime } from "./messageTime.ts";
import "./peer-messages.css";

export function PeerIdentity({
  id,
  name,
  size = 16,
  author = false,
}: {
  id: string;
  name: string;
  size?: number;
  author?: boolean;
}) {
  const { snapshot } = useAtomValue(agentsAtom);
  const avatar =
    snapshot.agents.find((agent) => agent.id === id)?.avatar ??
    defaultAgentAvatar(id);

  return (
    <a
      href={`#agent-${id}`}
      className="peer-identity"
      style={author ? { color: avatarColors[avatar.color] } : undefined}
    >
      <AgentAvatar avatar={avatar} size={size} animated={false} />
      <span>{name}</span>
    </a>
  );
}

export function peerCounterpart(message: ChatMessage, viewerId: string) {
  const peer = message.peer;

  if (!peer) return null;

  return peer.fromAgentId === viewerId
    ? { id: peer.toAgentId, name: peer.toName }
    : { id: peer.fromAgentId, name: peer.fromName };
}

function PeerTime({ createdAt }: { createdAt: string }) {
  const time = messageTime(createdAt);

  return time ? (
    <time dateTime={time.dateTime} title={time.fullLabel}>
      {time.label}
    </time>
  ) : null;
}

function PeerMessage({
  message,
  viewerId,
  expanded = false,
}: {
  message: ChatMessage;
  viewerId: string;
  expanded?: boolean;
}) {
  const peer = message.peer;
  const counterpart = peerCounterpart(message, viewerId);

  if (!peer || !counterpart) return null;

  const sent = peer.fromAgentId === viewerId;
  const label = sent
    ? peer.kind === "reply" || peer.expectsReply === false
      ? "Informed"
      : "Messaged"
    : peer.kind === "reply"
      ? "Update from"
      : "Message from";
  const delivery = message.delivery ?? peer.delivery;
  const failed = ["failed", "interrupted", "skipped", "cancelled"].includes(
    delivery,
  );

  return (
    <article
      className="chat-peer-event"
      aria-label={`${peer.fromName} to ${peer.toName}`}
      data-message-id={message.id}
    >
      <details open={expanded}>
        <summary className="chat-peer-summary">
          <span>{label}</span>
          <PeerIdentity id={counterpart.id} name={counterpart.name} />
          <PeerTime createdAt={message.createdAt} />
          {failed && (
            <span className="chat-peer-failure" role="status">
              {delivery === "cancelled"
                ? "Cancelled"
                : delivery === "interrupted"
                  ? "Interrupted"
                  : "Failed"}
            </span>
          )}
          <ChevronDownIcon size={14} className="peer-chevron" aria-hidden />
        </summary>
        <div className="chat-peer-body">
          <div className="chat-peer-author">
            <PeerIdentity
              id={peer.fromAgentId}
              name={peer.fromName}
              size={24}
              author
            />
          </div>
          <div className="chat-peer-content">
            {peer.requestText && (
              <blockquote className="chat-peer-quote">
                {peer.requestAuthor && (
                  <a href={`#agent-${peer.toAgentId}`}>{peer.requestAuthor}</a>
                )}
                <p>{peer.requestText}</p>
              </blockquote>
            )}
            <MessageMarkdown text={message.text} />
            {message.attachments?.map((attachment) => (
              <MessageAttachment
                key={attachment.id}
                attachment={attachment}
                agentId={viewerId}
              />
            ))}
          </div>
        </div>
      </details>
    </article>
  );
}

export function PeerExchange({
  messages,
  viewerId,
}: {
  messages: readonly ChatMessage[];
  viewerId: string;
}) {
  const first = messages[0];
  const last = messages.at(-1);
  const counterpart = first && peerCounterpart(first, viewerId);

  if (!first || !last || !counterpart) return null;
  if (messages.length === 1)
    return <PeerMessage message={first} viewerId={viewerId} />;

  return (
    <details className="chat-peer-group">
      <summary className="chat-peer-summary">
        <span>{messages.length} messages with</span>
        <PeerIdentity id={counterpart.id} name={counterpart.name} />
        <PeerTime createdAt={last.createdAt} />
        <ChevronDownIcon size={14} className="peer-chevron" aria-hidden />
      </summary>
      <div className="chat-peer-group-messages">
        {messages.map((message) => (
          <PeerMessage
            key={message.id}
            message={message}
            viewerId={viewerId}
            expanded
          />
        ))}
      </div>
    </details>
  );
}
