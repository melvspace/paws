import { useState } from "react";
import { DownloadIcon, FileIcon } from "lucide-react";
import type { ChatAttachment } from "@paws/contracts";
import { ChatImage } from "./ChatImage.tsx";

export function MessageAttachment({
  attachment,
  agentId,
}: {
  attachment: ChatAttachment;
  agentId: string;
}) {
  const preview = /^(image|audio|video)\//.test(attachment.mediaType);
  const [failed, setFailed] = useState(false);
  const url = `/api/agents/${encodeURIComponent(agentId)}/chat/attachments/${attachment.id}`;
  const size =
    attachment.size === undefined
      ? ""
      : attachment.size < 1024 * 1024
        ? `${Math.max(1, Math.round(attachment.size / 1024))} KB`
        : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div className="chat-attachment" data-preview={preview || undefined}>
      {attachment.mediaType.startsWith("image/") ? (
        <ChatImage src={url} alt={attachment.name} />
      ) : attachment.mediaType.startsWith("video/") ? (
        <video
          controls
          onError={() => setFailed(true)}
          preload="metadata"
          playsInline
          aria-label={attachment.name}
          src={url}
        />
      ) : attachment.mediaType.startsWith("audio/") ? (
        <audio
          controls
          onError={() => setFailed(true)}
          preload="metadata"
          aria-label={attachment.name}
          src={url}
        />
      ) : null}
      {failed && (
        <span className="chat-attachment-error" role="status">
          Preview unavailable. Download the file to open it.
        </span>
      )}
      <a
        className="chat-attachment-download"
        title={`Download ${attachment.name}`}
        href={url}
        download={attachment.name}
      >
        {!preview && (
          <span className="chat-attachment-icon">
            <FileIcon size={20} aria-hidden />
          </span>
        )}
        <span className="chat-attachment-name">
          <span title={attachment.name}>{attachment.name}</span>
          {size && <small>{size}</small>}
        </span>
        <DownloadIcon size={16} aria-hidden />
      </a>
    </div>
  );
}
