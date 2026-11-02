import { ReassignAgentDialog } from "./ReassignAgentDialog.tsx";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import {
  agentsAtom,
  saveTeam,
  getTeam,
  deleteTeam,
  conversationsAtom,
} from "@paws/client-runtime";
import type { Agent, Team, UpdateTeam } from "@paws/contracts";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Button } from "./components/ui/button.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { defaultAgentAvatar } from "@paws/contracts";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "./components/ui/alert-dialog.tsx";
import { TeamFiles } from "./TeamFiles.tsx";
import { TeamIntegrations } from "./TeamIntegrations.tsx";

const tabs = [
  "General",
  "Members",
  "Memories",
  "Files",
  "Skills",
  "Integrations",
] as const;

export function TeamsSettings({
  beforeClose,
}: {
  beforeClose?: RefObject<(() => Promise<void>) | null>;
}) {
  const { snapshot, connected } = useAtomValue(agentsAtom);
  const [selected, setSelected] = useState<Team | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("paws-team-runtime:1");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setPending(true);
    setError("");

    try {
      const team = await saveTeam({ name, memory: "", template });
      setSelected(team);
      setCreating(false);
      setName("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create team.",
      );
    } finally {
      setPending(false);
    }
  }

  if (selected)
    return (
      <TeamDetails
        key={selected.id}
        beforeClose={beforeClose}
        team={selected}
        onBack={() => setSelected(null)}
      />
    );

  return (
    <section className="teams-settings" aria-label="Teams">
      <div className="team-page-toolbar">
        <Button
          variant="outline"
          disabled={!connected || pending}
          onClick={() => setCreating(true)}
        >
          <PlusIcon size={14} />
          New team
        </Button>
      </div>
      {creating && (
        <form
          className="team-create"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Input
            aria-label="Team name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            required
            maxLength={80}
            disabled={pending}
          />
          <Input
            aria-label="Container template"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            required
            disabled={pending}
          />
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setCreating(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={pending || !connected || !name.trim()}
          >
            Create team
          </Button>
        </form>
      )}
      {!!snapshot.teams?.length && (
        <div className="settings-group team-collection">
          {snapshot.teams.map((team) => (
            <Button
              key={team.id}
              variant="ghost"
              className="team-collection-row"
              aria-label={team.name}
              onClick={() => setSelected(team)}
            >
              <span>{team.name}</span>
              <span className="team-row-meta">
                {
                  snapshot.agents.filter((agent) => agent.teamId === team.id)
                    .length
                }
              </span>
              <ChevronRightIcon size={16} />
            </Button>
          ))}
        </div>
      )}
      {!snapshot.teams?.length && !creating && (
        <p className="team-empty">No teams</p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function TeamDetails({
  team,
  onBack,
  beforeClose,
}: {
  team: Team;
  onBack(): void;
  beforeClose?: RefObject<(() => Promise<void>) | null> | undefined;
}) {
  const { snapshot, connected } = useAtomValue(agentsAtom);
  const conversations = useAtomValue(conversationsAtom);
  const [moveRequest, setMoveRequest] = useState<{
    agent: Agent;
    destination: Team | null;
  } | null>(null);
  const [tab, setTab] = useState<(typeof tabs)[number]>("General");
  const [draft, setDraft] = useState(team);
  const draftRef = useRef(team);
  const saved = useRef(team);
  const [editorVersion, setEditorVersion] = useState(0);
  const childFlush = useRef<(() => Promise<void>) | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function change(patch: Partial<Team>) {
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
    setError("");
  }

  function persist(): Promise<void> {
    if (inFlight.current) return inFlight.current;

    const request = (async () => {
      setPending(true);
      setError("");

      try {
        while (
          JSON.stringify(saved.current) !== JSON.stringify(draftRef.current)
        ) {
          const next = draftRef.current;
          const patch: {
            name?: string;
            memory?: string;
            integrations?: Team["integrations"];
          } = {};
          const expected: UpdateTeam["expected"] = {};

          for (const key of ["name", "memory", "integrations"] as const) {
            if (
              JSON.stringify(next[key]) !== JSON.stringify(saved.current[key])
            ) {
              Object.assign(patch, { [key]: next[key] });
              Object.assign(expected, {
                [key]: saved.current[key] ?? (key === "integrations" ? [] : ""),
              });
            }
          }

          const result = await saveTeam({ ...patch, expected }, team.id);
          const edits = draftRef.current;
          saved.current = result;

          if (draftRef.current === next) {
            draftRef.current = result;
            setDraft(result);
          } else {
            const merged = { ...result };

            for (const key of ["name", "memory", "integrations"] as const) {
              if (JSON.stringify(edits[key]) !== JSON.stringify(next[key])) {
                Object.assign(merged, { [key]: edits[key] });
              }
            }

            draftRef.current = merged;
            setDraft(merged);
          }
        }
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Could not save team.",
        );

        throw cause;
      } finally {
        setPending(false);
      }
    })().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = request;

    return request;
  }

  const flushRef = useRef(persist);
  useEffect(() => {
    flushRef.current = persist;
  });
  useEffect(() => {
    if (!beforeClose) return;

    const flush = async () => {
      await childFlush.current?.();
      await flushRef.current();
    };
    beforeClose.current = flush;

    return () => {
      if (beforeClose.current === flush) beforeClose.current = null;
    };
  }, [beforeClose]);

  function autosave() {
    void persist().catch(() => {});
  }

  async function discard() {
    setPending(true);

    try {
      await inFlight.current?.catch(() => {});
      const latest = await getTeam(team.id);

      if (!latest) {
        onBack();

        return;
      }

      saved.current = latest;
      draftRef.current = latest;
      setDraft(latest);
      setEditorVersion((value) => value + 1);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not reload team.",
      );
    } finally {
      setPending(false);
    }
  }

  async function back() {
    try {
      await childFlush.current?.();
      await persist();
      onBack();
    } catch {
      /* Keep failed edits open. */
    }
  }

  return (
    <section className="teams-settings" aria-label="Team settings">
      <div className="team-detail-heading">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to teams"
          onClick={() => void back()}
        >
          <ArrowLeftIcon size={16} />
        </Button>
        <span>{draft.name}</span>
      </div>
      <div className="team-tabs" role="tablist" aria-label="Team sections">
        {tabs.map((item) => (
          <Button
            key={item}
            role="tab"
            id={`team-tab-${item}`}
            aria-selected={tab === item}
            aria-controls="team-panel"
            variant="ghost"
            onClick={() => {
              void (async () => {
                await childFlush.current?.();
                await persist();
                setTab(item);
              })().catch(() => {});
            }}
          >
            {item}
          </Button>
        ))}
      </div>
      {error && (
        <div>
          <p role="alert">{error}</p>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void discard()}
          >
            Discard team edits
          </Button>
        </div>
      )}
      <div id="team-panel" role="tabpanel" aria-labelledby={`team-tab-${tab}`}>
        {tab === "General" && (
          <div className="settings-group team-collection">
            <div className="settings-row">
              <label htmlFor="team-name">Name</label>
              <Input
                id="team-name"
                value={draft.name}
                maxLength={80}
                disabled={!connected}
                onChange={(event) => change({ name: event.target.value })}
                onBlur={autosave}
              />
            </div>
            <div className="settings-row">
              <span>Container template</span>
              <span>{team.template ?? "paws-team-runtime:1"}</span>
            </div>
            <div className="settings-row">
              <span>Delete team</span>
              <Button
                variant="ghost"
                className="danger-button"
                aria-label="Delete team"
                disabled={pending || !connected}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2Icon size={16} />
              </Button>
            </div>
          </div>
        )}
        {tab === "Members" && (
          <div className="settings-group team-collection">
            {snapshot.agents.map((agent) => (
              <label className="team-member-row" key={agent.id}>
                <AgentAvatar
                  avatar={agent.avatar ?? defaultAgentAvatar(agent.id)}
                  animated={false}
                  activity="idle"
                />
                <span>{agent.name}</span>
                <Checkbox
                  aria-label={agent.name}
                  checked={agent.teamId === team.id}
                  disabled={
                    pending ||
                    !connected ||
                    conversations.some(
                      (conversation) =>
                        conversation.agentId === agent.id &&
                        conversation.status === "running",
                    )
                  }
                  onCheckedChange={(checked) => {
                    setMoveRequest({
                      agent,
                      destination: checked ? team : null,
                    });
                  }}
                />
              </label>
            ))}
            {!snapshot.agents.length && <p className="team-empty">No agents</p>}
          </div>
        )}
        {tab === "Memories" && (
          <Textarea
            aria-label="Shared memories"
            value={draft.memory}
            maxLength={16000}
            disabled={!connected}
            onChange={(event) => change({ memory: event.target.value })}
            onBlur={autosave}
          />
        )}
        {(tab === "Files" || tab === "Skills") && (
          <TeamFiles
            key={tab}
            teamId={team.id}
            kind={tab === "Skills" ? "skills" : "files"}
            disabled={!connected}
          />
        )}
        {tab === "Integrations" && (
          <TeamIntegrations
            key={editorVersion}
            beforeClose={childFlush}
            value={draft.integrations ?? []}
            onChange={async (integrations) => {
              change({ integrations });

              try {
                await persist();
              } catch (cause) {
                if (draftRef.current.integrations === integrations) {
                  draftRef.current = {
                    ...draftRef.current,
                    integrations: saved.current.integrations,
                  };
                  setDraft(draftRef.current);
                }

                throw cause;
              }
            }}
            teamId={team.id}
            disabled={!connected}
          />
        )}
      </div>
      {moveRequest && (
        <ReassignAgentDialog
          agent={moveRequest.agent}
          destination={moveRequest.destination}
          connected={connected}
          onClose={() => setMoveRequest(null)}
          onMoved={() => {}}
        />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {draft.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents and shared files stay on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setPending(true);
                void deleteTeam(team.id)
                  .then(onBack)
                  .catch(() => setError("Could not delete team."))
                  .finally(() => setPending(false));
              }}
            >
              Delete team
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
