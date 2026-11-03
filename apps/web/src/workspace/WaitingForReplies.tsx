import { useAtomValue } from "@effect/atom-react";
import { agentsAtom } from "@paws/client-runtime";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleAlertIcon,
} from "lucide-react";
import { PeerIdentity } from "./PeerMessage.tsx";

const labels = {
  queued: "Queued",
  working: "Working",
  waiting: "Waiting",
  done: "Replied",
  failed: "Failed",
  interrupted: "Interrupted",
};

export function WaitingForReplies({ agentId }: { agentId: string }) {
  const { snapshot, connected } = useAtomValue(agentsAtom);
  const waits = (snapshot.peerWaits ?? []).filter(
    (wait) => wait.agentId === agentId,
  );

  if (!waits.length || waits.every((wait) => wait.status === "done"))
    return null;

  const completed = waits.filter((wait) => wait.status === "done").length;
  const waiting = waits.some((wait) =>
    ["queued", "working", "waiting"].includes(wait.status),
  );

  return (
    <details className="peer-reply-waits" open>
      <summary className="peer-reply-waits-summary">
        {waiting ? (
          <CircleDashedIcon size={16} aria-hidden />
        ) : (
          <CircleAlertIcon size={16} aria-hidden />
        )}
        <span>
          {waiting ? "Waiting for replies" : "Replies need attention"}
        </span>
        <span
          className="peer-reply-count"
          aria-label={`${completed} of ${waits.length} replies received`}
        >
          {completed}/{waits.length}
        </span>
        <ChevronDownIcon size={14} className="peer-chevron" aria-hidden />
      </summary>
      <ul aria-label="Agent replies">
        {waits.map((wait) => (
          <li key={wait.requestId}>
            <PeerIdentity id={wait.toAgentId} name={wait.toName} size={20} />
            <span className="peer-reply-state" role="status">
              {connected ? labels[wait.status] : "Disconnected"}
              {wait.status === "done" ? (
                <CheckIcon size={14} aria-hidden />
              ) : wait.status === "failed" || wait.status === "interrupted" ? (
                <CircleAlertIcon size={14} aria-hidden />
              ) : (
                <CircleDashedIcon size={14} aria-hidden />
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
