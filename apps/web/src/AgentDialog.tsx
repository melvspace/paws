import { Input } from "./components/ui/input.tsx";
import { Button } from "./components/ui/button.tsx";
import { useRef, useState, type FormEvent } from "react";
import { Trash2Icon, XIcon } from "lucide-react";
import { createAgent, deleteAgent, updateAgent } from "@paws/client-runtime";
import {
  defaultAgentAvatar,
  type Agent,
  type AgentAvatar,
} from "@paws/contracts";
import { AvatarPicker } from "./AvatarPicker.tsx";
import { Form } from "@base-ui/react/form";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogClose,
} from "./components/ui/dialog.tsx";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "./components/ui/alert-dialog.tsx";

interface AgentDialogProps {
  agent: Agent | null;
  connected: boolean;
  onDismiss: () => void;
}

export function AgentDialog({ agent, connected, onDismiss }: AgentDialogProps) {
  const returnFocusRef = useRef(document.activeElement);
  const keepAgentRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const [avatar, setAvatar] = useState<AgentAvatar>(
    () => agent?.avatar ?? defaultAgentAvatar(agent?.id ?? crypto.randomUUID()),
  );
  const saved = useRef({ name: agent?.name ?? "", avatar });
  const [name, setName] = useState(agent?.name ?? "");
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function saveAgent(nextAvatar = avatar): Promise<boolean> {
    if (saveInFlight.current) {
      return saveInFlight.current;
    }

    const nextName = name.trim();

    if (
      !agent ||
      (nextName === saved.current.name &&
        nextAvatar.animal === saved.current.avatar.animal &&
        nextAvatar.color === saved.current.avatar.color)
    ) {
      return Promise.resolve(true);
    }

    if (!nextName || nextName.length > 80) {
      setError("Enter a name of 1–80 characters.");
      inputRef.current?.focus();

      return Promise.resolve(false);
    }

    if (!connected) {
      setError("Reconnect to save your changes.");

      return Promise.resolve(false);
    }

    setPending("save");
    setError(null);
    const request = updateAgent(agent.id, {
      name: nextName,
      avatar: nextAvatar,
    })
      .then(() => {
        saved.current = { name: nextName, avatar: nextAvatar };
        setName(nextName);

        return true;
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : "Unable to save agent.",
        );

        return false;
      })
      .finally(() => {
        saveInFlight.current = null;
        setPending(null);
      });
    saveInFlight.current = request;

    return request;
  }

  async function dismiss() {
    if (pending === "delete" || (!agent && pending)) {
      return;
    }

    if (!agent || (await saveAgent())) {
      onDismiss();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending || !connected || confirmingDelete) {
      return;
    }

    if (agent) {
      await saveAgent();

      return;
    }

    if (!name.trim()) {
      setError("Enter a name for your agent.");

      return;
    }

    setPending("save");
    setError(null);

    try {
      const created = await createAgent({ name: name.trim(), avatar });
      location.hash = `agent-${created.id}`;
      onDismiss();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to create agent.",
      );
    } finally {
      setPending(null);
    }
  }

  async function remove() {
    if (!agent || !confirmingDelete || pending || !connected) {
      return;
    }

    setPending("delete");
    setError(null);

    try {
      await deleteAgent(agent.id);

      if (location.hash === `#agent-${agent.id}`) {
        history.replaceState(
          history.state,
          "",
          `${location.pathname}${location.search}`,
        );
      }

      onDismiss();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to delete agent.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (!open) {
          details.cancel();
          void dismiss();
        }
      }}
    >
      <DialogPopup
        className={
          agent ? "agent-dialog agent-settings-dialog" : "agent-dialog"
        }
        aria-busy={pending !== null}
        initialFocus={inputRef}
        finalFocus={() => {
          const previous = returnFocusRef.current;

          return previous instanceof HTMLElement && previous.isConnected
            ? previous
            : document.querySelector<HTMLButtonElement>(
                'button[aria-label="New agent"]',
              );
        }}
      >
        <div className="dialog-heading">
          <DialogTitle className={agent ? "sr-only" : undefined}>
            {agent ? "Agent settings" : "New agent"}
          </DialogTitle>
          <Button
            type="button"
            className="sidebar-icon-button"
            aria-label="Close dialog"
            disabled={pending === "delete" || (!agent && pending !== null)}
            render={<DialogClose />}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!connected && <p role="status">Reconnecting…</p>}
        <Form onSubmit={(event) => void submit(event)}>
          <AvatarPicker
            value={avatar}
            disabled={pending !== null || confirmingDelete || !connected}
            onChange={(nextAvatar) => {
              setAvatar(nextAvatar);
              setError(null);

              if (agent) {
                void saveAgent(nextAvatar);
              }
            }}
          />
          <div className={agent ? "settings-group" : undefined}>
            <div className={agent ? "settings-row" : undefined}>
              <div className="settings-copy">
                <label htmlFor="agent-name">Name</label>
              </div>
              <Input
                id="agent-name"
                name="name"
                ref={inputRef}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                onBlur={(event) => {
                  if (
                    event.relatedTarget instanceof Node &&
                    event.currentTarget.form?.contains(event.relatedTarget)
                  ) {
                    return;
                  }

                  if (agent && !confirmingDelete && pending !== "delete") {
                    void saveAgent();
                  }
                }}
                required
                maxLength={80}
                placeholder="e.g. Ada"
                readOnly={agent !== null && pending === "save"}
                disabled={
                  pending === "delete" ||
                  (!agent && pending !== null) ||
                  confirmingDelete
                }
              />
            </div>
          </div>

          {!agent && (
            <div className="actions">
              <Button
                type="button"
                className="secondary"
                disabled={pending !== null}
                onClick={onDismiss}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending !== null || !connected}>
                {pending === "save" ? "Creating…" : "Create agent"}
              </Button>
            </div>
          )}
        </Form>
        {agent && (
          <section
            className="settings-danger"
            aria-labelledby="agent-danger-title"
          >
            <h3 id="agent-danger-title">Danger</h3>
            <div className="settings-group">
              <div className="settings-row">
                <div className="settings-copy">
                  <h4>Delete agent</h4>
                  <p>Files stay on disk.</p>
                </div>
                <Button
                  type="button"
                  className="danger-button"
                  disabled={pending !== null || !connected}
                  onClick={() => {
                    void saveAgent().then((saved) => {
                      if (saved) {
                        setError(null);
                        setConfirmingDelete(true);
                      }
                    });
                  }}
                >
                  <Trash2Icon size={16} aria-hidden />
                  Delete agent
                </Button>
              </div>
            </div>
          </section>
        )}
        <AlertDialog
          open={confirmingDelete}
          onOpenChange={(open) => {
            if (pending !== "delete") setConfirmingDelete(open);
          }}
        >
          <AlertDialogPopup initialFocus={keepAgentRef}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {name.trim()}?</AlertDialogTitle>
              <AlertDialogDescription>
                Files stay on disk.
                <br />
                This action cannot be undone.
              </AlertDialogDescription>
              {error && <p role="alert">{error}</p>}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                ref={keepAgentRef}
                variant="outline"
                disabled={pending !== null}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={pending !== null || !connected}
                onClick={() => void remove()}
              >
                {pending === "delete" ? "Deleting…" : "Confirm"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </DialogPopup>
    </Dialog>
  );
}
