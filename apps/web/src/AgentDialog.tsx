import { ReassignAgentDialog } from "./ReassignAgentDialog.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { useAtomValue } from "@effect/atom-react";
import { agentsAtom, conversationsAtom } from "@paws/client-runtime";
import { Input } from "./components/ui/input.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MutableRefObject,
} from "react";
import {
  Trash2Icon,
  XIcon,
  Clock3Icon,
  ChevronRightIcon,
  BrainIcon,
} from "lucide-react";
import { createAgent, deleteAgent, updateAgent } from "@paws/client-runtime";
import { defaultAgentAvatar, type Agent } from "@paws/contracts";
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
  initialTeamId?: string | null;
  connected: boolean;
  onDismiss: () => void;
  embedded?: boolean;
  beforeClose?: MutableRefObject<(() => Promise<void>) | null>;
  onRoutines?: () => void;
  onMemories?: () => void;
}

export function AgentDialog({
  agent,
  initialTeamId = null,
  connected,
  onDismiss,
  embedded = false,
  beforeClose,
  onRoutines,
  onMemories,
}: AgentDialogProps) {
  const returnFocusRef = useRef(document.activeElement);
  const keepAgentRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const { snapshot } = useAtomValue(agentsAtom);
  const conversations = useAtomValue(conversationsAtom);
  const idle =
    !agent ||
    !conversations.some(
      (conversation) =>
        conversation.agentId === agent.id && conversation.status === "running",
    );
  const [draft, setDraft] = useState(() => ({
    name: agent?.name ?? "",
    role: agent?.role ?? "",
    description: agent?.description ?? "",
    avatar:
      agent?.avatar ??
      defaultAgentAvatar(agent?.id ?? Math.random().toString(36)),
    teamId: agent?.teamId ?? initialTeamId,
    sandbox: agent?.sandbox ?? false,
  }));
  const draftRef = useRef(draft);
  const saved = useRef(draft);
  const { name, role, description, avatar, teamId, sandbox } = draft;

  function change(patch: Partial<typeof draft>) {
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
    setError(null);
  }

  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [moveDestination, setMoveDestination] = useState<{
    teamId: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function saveAgent(): Promise<boolean> {
    if (saveInFlight.current) return saveInFlight.current;
    if (!agent) return Promise.resolve(true);

    const request = (async () => {
      while (true) {
        const next = {
          ...draftRef.current,
          name: draftRef.current.name.trim(),
        };

        if (JSON.stringify(next) === JSON.stringify(saved.current)) return true;
        if (!next.name || next.name.length > 80) {
          setError("Enter a name of 1–80 characters.");
          inputRef.current?.focus();

          return false;
        }

        if (!connected) {
          setError("Reconnect to save your changes.");

          return false;
        }

        setPending("save");
        setError(null);

        try {
          await updateAgent(agent.id, {
            name: next.name,
            ...(next.role !== saved.current.role ? { role: next.role } : {}),
            ...(next.description !== saved.current.description
              ? { description: next.description }
              : {}),
            avatar: next.avatar,
            ...(next.sandbox !== saved.current.sandbox
              ? { sandbox: next.sandbox }
              : {}),
          });
          saved.current = next;

          if (draftRef.current.name.trim() === next.name) {
            draftRef.current = { ...draftRef.current, name: next.name };
            setDraft(draftRef.current);
          }
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : "Unable to save agent.",
          );

          return false;
        }
      }
    })().finally(() => {
      saveInFlight.current = null;
      setPending(null);
    });
    saveInFlight.current = request;

    return request;
  }

  useEffect(() => {
    if (!beforeClose) return;

    const flush = async () => {
      if (
        pending === "delete" ||
        confirmingDelete ||
        moveDestination ||
        !(await saveAgent())
      ) {
        throw new Error("Agent settings could not be saved.");
      }
    };
    beforeClose.current = flush;

    return () => {
      if (beforeClose.current === flush) beforeClose.current = null;
    };
  });

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
      const created = await createAgent({
        name: name.trim(),
        ...(role.trim() ? { role: role.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        avatar,
        teamId,
        sandbox,
      });
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

  const content = (
    <>
      {!embedded && (
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
      )}
      {error && <p role="alert">{error}</p>}
      {!connected && <p role="status">Reconnecting…</p>}
      <Form onSubmit={(event) => void submit(event)}>
        <AvatarPicker
          compact={embedded || !agent}
          value={avatar}
          disabled={
            pending === "delete" ||
            (!agent && pending !== null) ||
            confirmingDelete ||
            !connected
          }
          onChange={(nextAvatar) => {
            change({ avatar: nextAvatar });

            if (agent) {
              void saveAgent();
            }
          }}
        />
        <div
          className={
            agent
              ? "settings-group agent-settings-fields"
              : "agent-settings-fields agent-create-fields creation-dialog-fields"
          }
        >
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
                change({ name: event.target.value });
              }}
              onBlur={() => {
                if (agent && !confirmingDelete && pending !== "delete") {
                  void saveAgent();
                }
              }}
              required
              maxLength={80}
              placeholder={embedded ? undefined : "e.g. Ada"}
              disabled={
                pending === "delete" ||
                (!agent && pending !== null) ||
                confirmingDelete
              }
            />
          </div>

          {(["role", "description"] as const).map((field) => (
            <div key={field} className={agent ? "settings-row" : undefined}>
              <label htmlFor={`agent-${field}`}>
                {field === "role" ? "Role" : "Description"}
              </label>
              <Input
                id={`agent-${field}`}
                name={field}
                value={draft[field]}
                maxLength={field === "role" ? 160 : 2000}
                disabled={
                  pending === "delete" ||
                  (!agent && pending !== null) ||
                  confirmingDelete
                }
                onChange={(event) => change({ [field]: event.target.value })}
                onBlur={() => {
                  if (agent && !confirmingDelete && pending !== "delete")
                    void saveAgent();
                }}
              />
            </div>
          ))}
          {agent && (
            <div className="settings-row">
              <label htmlFor="agent-team">Team</label>
              <select
                id="agent-team"
                value={teamId ?? ""}
                disabled={
                  !connected || pending !== null || confirmingDelete || !idle
                }
                onChange={(event) => {
                  const next = event.target.value || null;

                  if (agent) setMoveDestination({ teamId: next });
                  else change({ teamId: next });
                }}
              >
                <option value="">Unassigned</option>
                {(snapshot.teams ?? []).map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!teamId && (
            <div className={agent ? "settings-row" : "agent-sandbox-row"}>
              <label htmlFor="agent-sandbox">Sandbox</label>
              <Switch
                id="agent-sandbox"
                className="agent-sandbox-switch"
                checked={sandbox}
                disabled={
                  !connected || pending !== null || confirmingDelete || !idle
                }
                onCheckedChange={(checked) => {
                  change({ sandbox: checked });

                  if (agent) void saveAgent();
                }}
              />
            </div>
          )}
        </div>
        {!agent && (
          <div className="actions">
            <Button
              type="button"
              variant="ghost"
              disabled={pending !== null}
              onClick={onDismiss}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending !== null || !connected || !name.trim()}
            >
              {pending === "save" ? "Creating…" : "Create agent"}
            </Button>
          </div>
        )}
      </Form>
      {agent && (onRoutines || onMemories) && (
        <div className="settings-group agent-settings-menu">
          {onMemories && (
            <Button
              type="button"
              variant="ghost"
              className="settings-row agent-settings-menu-item"
              onClick={onMemories}
            >
              <BrainIcon size={18} aria-hidden />
              <span>Memories</span>
              <ChevronRightIcon size={16} aria-hidden />
            </Button>
          )}
          {onRoutines && (
            <Button
              type="button"
              variant="ghost"
              className="settings-row agent-settings-menu-item"
              onClick={onRoutines}
            >
              <Clock3Icon size={18} aria-hidden />
              <span>Routines</span>
              <ChevronRightIcon size={16} aria-hidden />
            </Button>
          )}
        </div>
      )}
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
      {agent && moveDestination && (
        <ReassignAgentDialog
          agent={{ ...agent, teamId: saved.current.teamId }}
          destination={
            snapshot.teams?.find(
              (team) => team.id === moveDestination.teamId,
            ) ?? null
          }
          connected={connected}
          onClose={() => setMoveDestination(null)}
          onMoved={() => {
            saved.current = {
              ...saved.current,
              teamId: moveDestination.teamId,
            };
            change({ teamId: moveDestination.teamId });
          }}
        />
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
    </>
  );

  if (embedded) {
    return (
      <section
        className="agent-settings-content"
        aria-label="Agent settings"
        aria-busy={pending !== null}
      >
        {content}
      </section>
    );
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
          agent
            ? "agent-dialog agent-settings-dialog"
            : "agent-dialog creation-dialog agent-create-dialog"
        }
        aria-busy={pending !== null}
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
        {content}
      </DialogPopup>
    </Dialog>
  );
}
