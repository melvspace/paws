import { useState } from "react";
import { PencilIcon, PlayIcon, XIcon } from "lucide-react";
import type {
  ChatQueuedInput,
  ChatQueueAction,
  Conversation,
} from "@paws/contracts";
import { Button } from "../components/ui/button.tsx";
import { Textarea } from "../components/ui/textarea.tsx";

function QueuedMessage({
  entry,
  label,
  busy,
  onUpdate,
}: {
  entry: ChatQueuedInput;
  label: string;
  busy: boolean;
  onUpdate: (action: ChatQueueAction) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);

  return (
    <li className="chat-held-message">
      {editing ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const saved = await onUpdate({
              action: "edit",
              requestId: entry.requestId,
              text: draft,
            });

            if (saved) setEditing(false);
          }}
        >
          <Textarea
            aria-label="Edit queued message"
            value={draft}
            maxLength={32000}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          <div className="chat-recovery-actions">
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !draft.trim()}
            >
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel edit
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p>{label}</p>
          <div className="chat-recovery-actions">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void onUpdate({ action: "resume", requestId: entry.requestId })
              }
              aria-label="Resume queued message"
            >
              <PlayIcon size={13} aria-hidden />
              Resume
            </Button>
            {!entry.reply && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(entry.text);
                  setEditing(true);
                }}
                aria-label="Edit queued message"
              >
                <PencilIcon size={13} aria-hidden />
                Edit
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void onUpdate({ action: "remove", requestId: entry.requestId })
              }
              aria-label="Remove queued message"
            >
              <XIcon size={13} aria-hidden />
              Remove
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

export function ChatRecovery({
  conversation,
  busy,
  onUpdate,
  onContinue,
}: {
  conversation: Conversation;
  busy: boolean;
  onUpdate: (action: ChatQueueAction) => Promise<boolean>;
  onContinue: () => Promise<boolean>;
}) {
  const held = conversation.queue?.filter((entry) => entry.held) ?? [];

  return (
    <>
      {conversation.interrupted && (
        <div className="chat-restart-notice" role="status">
          <span>Reply interrupted by server restart</span>
          <Button
            variant="outline"
            disabled={busy || conversation.status === "running"}
            onClick={() => void onContinue()}
          >
            Continue
          </Button>
        </div>
      )}
      {held.length > 0 && (
        <section
          className="chat-held-queue"
          aria-label="Messages held after restart"
        >
          <div className="chat-held-heading">
            {held.length} queued · Paused after restart
          </div>
          <ol>
            {held.map((entry) => {
              const original = conversation.messages.find(
                (message) => message.id === entry.reply?.messageId,
              );
              const label = entry.reply
                ? `${original?.text ?? "Interactive response"} — ${original?.interaction?.action.label ?? entry.reply.actionId}`
                : entry.text || "Attached files";

              return (
                <QueuedMessage
                  key={entry.requestId}
                  entry={entry}
                  label={label}
                  busy={busy}
                  onUpdate={onUpdate}
                />
              );
            })}
          </ol>
        </section>
      )}
    </>
  );
}
