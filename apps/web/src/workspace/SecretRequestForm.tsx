// Adapted from T3 Code's SecretRequestCard: private input, explicit consent, no chat echo.
import { useId, useRef, useState } from "react";
import { Form } from "@base-ui/react/form";
import { ShieldCheckIcon } from "lucide-react";
import type { SendChat } from "@paws/contracts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";

export function SecretRequestForm({
  messageId,
  label,
  disabled,
  onReply,
}: {
  messageId: string;
  label: string;
  disabled: boolean;
  onReply: (reply: NonNullable<SendChat["reply"]>) => Promise<boolean>;
}) {
  const id = useId();
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);

  async function send(actionId: "save" | "decline") {
    if (pending.current || disabled) return;

    pending.current = true;
    setSubmitting(true);

    try {
      const saved = await onReply({
        messageId,
        actionId,
        values: {},
        ...(actionId === "save" ? { secret } : {}),
      });

      if (saved) setSecret("");
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Form
      className="chat-secret-form"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void send("save");
      }}
    >
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        placeholder="Enter secret…"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        maxLength={16000}
        required
        disabled={disabled || submitting}
        aria-describedby={`${id}-privacy`}
      />
      <p id={`${id}-privacy`} className="chat-secret-privacy">
        <ShieldCheckIcon size={15} aria-hidden />
        Available to this agent as a private file for its next turn. Not saved
        in chat.
      </p>
      <div className="chat-card-actions">
        <Button
          type="submit"
          disabled={disabled || submitting || !secret.trim()}
        >
          Save securely
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || submitting}
          onClick={() => void send("decline")}
        >
          Decline
        </Button>
      </div>
    </Form>
  );
}
