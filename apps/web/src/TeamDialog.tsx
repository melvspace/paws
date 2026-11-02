import { useRef, useState, type FormEvent } from "react";
import { XIcon } from "lucide-react";
import { saveTeam } from "@paws/client-runtime";
import type { Team } from "@paws/contracts";
import { Form } from "@base-ui/react/form";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTitle,
} from "./components/ui/dialog.tsx";

export function TeamDialog({
  connected,
  onDismiss,
  onCreated,
}: {
  connected: boolean;
  onDismiss: () => void;
  onCreated?: (team: Team) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef(document.activeElement);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending || !connected || !name.trim()) return;

    setPending(true);
    setError("");

    try {
      const team = await saveTeam({
        name: name.trim(),
        memory: "",
      });
      onCreated?.(team);
      onDismiss();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create team.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (!open) {
          details.cancel();

          if (!pending) onDismiss();
        }
      }}
    >
      <DialogPopup
        className="agent-dialog creation-dialog"
        aria-busy={pending}
        initialFocus={inputRef}
        finalFocus={() => {
          const previous = returnFocusRef.current;

          return previous instanceof HTMLElement && previous.isConnected
            ? previous
            : document.querySelector<HTMLButtonElement>(
                'button[aria-label="Create new"]',
              );
        }}
      >
        <div className="dialog-heading">
          <DialogTitle>New team</DialogTitle>
          <Button
            type="button"
            className="sidebar-icon-button"
            aria-label="Close dialog"
            disabled={pending}
            render={<DialogClose />}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!connected && <p role="status">Reconnecting…</p>}
        <Form onSubmit={(event) => void submit(event)}>
          <div className="creation-dialog-fields">
            <div>
              <label htmlFor="team-name">Name</label>
              <Input
                id="team-name"
                name="name"
                ref={inputRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
                disabled={pending}
              />
            </div>
          </div>
          <div className="actions">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={onDismiss}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || !connected || !name.trim()}
            >
              {pending ? "Creating…" : "Create team"}
            </Button>
          </div>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}
