import { useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.tsx";
import "./chat-image.css";

export function ChatImage({
  src,
  alt,
  title,
}: {
  src: string;
  alt: string;
  title?: string | undefined;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const label = alt || "Image";

  return (
    <Dialog onOpenChange={(open) => open && setStatus("loading")}>
      <DialogTrigger
        render={<Button className="chat-image-trigger" variant="ghost" />}
        aria-label={`Preview ${label}`}
      >
        <img
          src={src}
          alt={alt}
          title={title}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </DialogTrigger>
      <DialogPopup className="chat-image-preview">
        <header className="chat-image-preview-header">
          <DialogTitle>{label}</DialogTitle>
          <Button
            render={<DialogClose />}
            variant="ghost"
            size="icon"
            aria-label="Close image preview"
          >
            <XIcon size={18} />
          </Button>
        </header>
        <div className="chat-image-preview-content">
          {status === "loading" && <span role="status">Loading image…</span>}
          {status === "error" && (
            <span role="alert">This image could not be loaded.</span>
          )}
          <img
            src={src}
            alt={alt}
            referrerPolicy="no-referrer"
            data-ready={status === "ready"}
            onLoad={() => setStatus("ready")}
            onError={() => setStatus("error")}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
