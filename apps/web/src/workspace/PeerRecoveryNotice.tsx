import { useAtomValue } from "@effect/atom-react";
import {
  agentsAtom,
  peerRetriesAtom,
  retryPeerMessage,
} from "@paws/client-runtime";
import type { PeerMessageRecovery } from "@paws/contracts";
import { InfoIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { appAtomRegistry } from "../lib/atomRegistry.ts";

export function PeerRecoveryNotice({
  agentId,
  recovery,
  allowRetry = true,
}: {
  agentId: string;
  recovery: PeerMessageRecovery;
  allowRetry?: boolean;
}) {
  const { connected } = useAtomValue(agentsAtom);
  const retries = useAtomValue(peerRetriesAtom);
  const state = retries[recovery.eventId];
  const retried = recovery.retried || state?.status === "retried";
  const pending = state?.status === "retrying";
  const canRetry = recovery.canRetry && allowRetry && !retried;
  const details = [
    retried
      ? "This attempt was retried. See the newer message for its progress."
      : recovery.reason,
    canRetry
      ? recovery.kind === "reply"
        ? "Retry delivers the saved reply and files again."
        : "Retry sends the original request and files again."
      : "",
    canRetry && !connected ? "Reconnect to retry." : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className="peer-recovery">
      <Button
        variant="ghost"
        className="peer-recovery-info"
        aria-label={`${recovery.kind === "reply" ? "Reply" : "Request"} details`}
        title={details}
      >
        <InfoIcon size={14} aria-hidden />
      </Button>
      {canRetry && (
        <Button
          variant="outline"
          className="peer-retry-button"
          aria-label={`Retry ${recovery.kind}`}
          disabled={!connected || pending}
          onClick={() =>
            void retryPeerMessage(appAtomRegistry, agentId, recovery.eventId)
          }
        >
          <RotateCcwIcon size={14} aria-hidden />
          {pending ? "Retrying…" : "Retry"}
        </Button>
      )}
      {!retried && state?.status === "failed" && (
        <span className="peer-recovery-error chat-peer-failure" role="alert">
          {state.error}
        </span>
      )}
    </span>
  );
}
