import { useEffect, useRef, useState } from "react";
import { uploadChatAttachment } from "@paws/client-runtime";
import type { ChatAttachment } from "@paws/contracts";

export function useComposerAttachments(
  agentId: string,
  attachments: readonly ChatAttachment[],
  onAdd: (attachment: ChatAttachment) => void,
) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => pending.current?.abort(), [agentId]);

  async function add(files: readonly File[]) {
    if (!files.length || pending.current) return;

    if (
      attachments.length + files.length > 4 ||
      files.some((file) => !file.size || file.size > 64 * 1024 * 1024) ||
      [...attachments, ...files].reduce(
        (size, file) => size + (file.size ?? 0),
        0,
      ) >
        128 * 1024 * 1024
    ) {
      setError("Attach up to 4 non-empty files, 64 MB each and 128 MB total.");

      return;
    }

    const controller = new AbortController();
    pending.current = controller;
    setUploading(true);
    setError(null);

    try {
      for (const file of files) {
        const attachment = await uploadChatAttachment(
          agentId,
          file,
          controller.signal,
        );

        if (!controller.signal.aborted) onAdd(attachment);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "Upload failed. Try again.",
        );
    } finally {
      if (pending.current === controller) pending.current = null;

      if (!controller.signal.aborted) setUploading(false);
    }
  }

  return { add, uploading, error };
}
