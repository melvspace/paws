import {
  CheckIcon,
  Clock3Icon,
  PlusIcon,
  ChevronLeftIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { Switch } from "../components/ui/switch.tsx";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  agentsAtom,
  loadRoutines,
  saveRoutine,
  routinePath,
  routineRequest,
} from "@paws/client-runtime";
import { Schema } from "effect";
import {
  type Routine,
  type SaveRoutine,
  RoutineState,
  type RoutineFilterGroup,
} from "@paws/contracts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { RoutineConditionBuilder } from "./RoutineConditionBuilder.tsx";
import "./routines.css";

type State = typeof RoutineState.Type;
type WebhookSecret = { endpoint: string; secret: string };
const empty: State = { routines: [], runs: [], events: [] };
const defaultRoutine = (): SaveRoutine => ({
  name: "",
  instruction: "",
  enabled: true,
  missed: "skip",
  timeoutMinutes: 60,
  trigger: {
    kind: "cron",
    expression: "0 9 * * 1-5",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
});

function formatRoutineTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function localDateTime(value: string) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) return "";

  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

function calendarParts(expression: string) {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(expression);

  if (!match) return null;

  return {
    minute: Number(match[1]),
    hour: Number(match[2]),
    day: match[3]!,
    repeat:
      match[3] === "*" ? "daily" : match[3] === "1-5" ? "weekdays" : "weekly",
  };
}

function scheduleLabel(trigger: SaveRoutine["trigger"]) {
  if (trigger.kind === "interval")
    return `Every ${trigger.minutes} ${trigger.minutes === 1 ? "minute" : "minutes"}`;
  if (trigger.kind === "once") return formatRoutineTime(trigger.at);
  if (trigger.kind === "webhook") return "Webhook";

  const presets: Record<string, string> = {
    "0 9 * * *": "Daily at 09:00",
    "0 9 * * 1-5": "Weekdays at 09:00",
    "0 9 * * 1": "Mondays at 09:00",
  };

  return `${presets[trigger.expression] ?? trigger.expression} · ${trigger.timezone}`;
}

function RoutineLoading() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 200);

    return () => clearTimeout(timer);
  }, []);

  return visible ? <p role="status">Loading routines…</p> : null;
}

export function RoutinesSettings({
  beforeClose,
  agentId,
  onBack,
}: {
  beforeClose: MutableRefObject<(() => Promise<void>) | null>;
  agentId: string;
  onBack: () => void;
}) {
  const { snapshot, connected } = useAtomValue(agentsAtom);
  const [state, setState] = useState<State>(empty);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationErrors, setMutationErrors] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [runCursors, setRunCursors] = useState<readonly number[]>([]);
  const runCursor = runCursors.at(-1);
  const [secret, setSecret] = useState<WebhookSecret | null>(null);
  const unacknowledgedSecret = useRef<WebhookSecret | null>(null);
  const [secretBlocked, setSecretBlocked] = useState(false);
  const flush = useRef<(() => Promise<void>) | null>(null);
  const mutation = useRef(0);
  const listSaves = useRef(new Map<string, Promise<Routine>>());
  const [savingIds, setSavingIds] = useState<readonly string[]>([]);

  function revealSecret(webhook: WebhookSecret) {
    unacknowledgedSecret.current = webhook;
    setSecret(webhook);
    setSecretBlocked(false);
  }

  function clearMutationError(id: string) {
    setMutationErrors((current) => {
      const next = new Map(current);
      next.delete(id);

      return next;
    });
  }

  function acceptSaved(routine: Routine) {
    mutation.current++;
    setState((current) => ({
      ...current,
      routines: current.routines.some((item) => item.id === routine.id)
        ? current.routines.map((item) =>
            item.id === routine.id ? routine : item,
          )
        : [...current.routines, routine],
    }));
  }

  function toggleRoutine(routine: Routine, enabled: boolean) {
    if (listSaves.current.has(routine.id)) return;

    setSavingIds((current) => [...current, routine.id]);
    const task = saveRoutine(
      agentId,
      { ...routine, enabled },
      routine.id,
      routine.revision,
    )
      .then(({ routine: saved }) => {
        acceptSaved(saved);
        clearMutationError(saved.id);

        return saved;
      })
      .finally(() => {
        listSaves.current.delete(routine.id);
        setSavingIds((current) => current.filter((id) => id !== routine.id));
      });
    listSaves.current.set(routine.id, task);
    void task.catch((cause) =>
      setMutationErrors((current) =>
        new Map(current).set(routine.id, String(cause)),
      ),
    );
  }

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    async function refresh() {
      const startedAtMutation = mutation.current;

      try {
        const next = await loadRoutines(agentId, controller.signal, runCursor);

        if (active) {
          setState((current) => {
            const existing = new Map(
              current.routines.map((item) => [item.id, item]),
            );

            return {
              ...next,
              routines:
                startedAtMutation !== mutation.current
                  ? current.routines
                  : next.routines.map((item) => {
                      const saved = existing.get(item.id);

                      return saved && saved.revision > item.revision
                        ? saved
                        : item;
                    }),
            };
          });
          setLoadError(null);
        }
      } catch (cause) {
        if (active)
          setLoadError(
            cause instanceof Error ? cause.message : "Could not load routines.",
          );
      } finally {
        if (active) {
          setLoading(false);
          timer = setTimeout(() => void refresh(), 2500);
        }
      }
    }

    setLoading(true);

    if (agentId) void refresh();
    else setLoading(false);

    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [agentId, runCursor]);

  useEffect(() => {
    const save = async () => {
      await Promise.all(listSaves.current.values());
      await flush.current?.();

      if (unacknowledgedSecret.current) {
        setSecretBlocked(true);

        throw new Error(
          "Acknowledge the webhook secret before leaving settings.",
        );
      }
    };
    beforeClose.current = save;

    return () => {
      if (beforeClose.current === save) beforeClose.current = null;
    };
  }, [beforeClose]);

  async function select(next: Routine | "new" | null) {
    try {
      const saved =
        next && next !== "new"
          ? await listSaves.current.get(next.id)
          : undefined;
      await flush.current?.();
      setEditing(saved ?? next);
    } catch {
      /* Keep failed edits visible. */
    }
  }

  if (!snapshot.agents.length) return <p>Create an agent to add routines.</p>;

  const detail = editing !== null;
  const title =
    editing === "new" ? "New routine" : editing ? editing.name : "Routines";

  return (
    <section
      aria-label="Routines"
      className="routines-settings"
      aria-busy={loading}
    >
      <nav className="routine-breadcrumb" aria-label="Routine navigation">
        <Button
          variant="ghost"
          className="routine-breadcrumb-parent"
          aria-label={detail ? "Back to routines" : "Agent settings"}
          onClick={detail ? () => void select(null) : onBack}
        >
          <ChevronLeftIcon size={14} aria-hidden />
          {detail ? "Routines" : "Agent settings"}
        </Button>
        <span aria-hidden>/</span>
        <h2 title={title}>{title}</h2>
        {!detail && (
          <Button
            className="routine-new"
            variant="outline"
            disabled={!connected || !!secret}
            onClick={() => void select("new")}
          >
            <PlusIcon size={14} aria-hidden />
            New
          </Button>
        )}
      </nav>
      <div className="routine-agent-panel">
        {!connected && <p role="status">Reconnecting…</p>}
        {loadError && <p role="alert">{loadError}</p>}
        {[...mutationErrors].map(([id, message]) => (
          <p key={id} role="alert">
            {message}
          </p>
        ))}
        {secret && (
          <div className="settings-group routine-secret">
            <p>Copy this webhook secret now. It is shown once.</p>
            {secretBlocked && (
              <p role="alert">
                Copy and dismiss this secret before leaving settings.
              </p>
            )}
            <label>
              Endpoint
              <Input readOnly value={secret.endpoint} />
            </label>
            <label>
              Webhook secret
              <Input readOnly value={secret.secret} />
            </label>
            <p>
              GitHub, GitLab, and Standard Webhooks (HMAC) are recognized
              automatically. Use this secret in the sender’s webhook settings.
              Other senders can POST JSON with Authorization: Bearer followed by
              this secret.
            </p>
            <Button
              onClick={() => {
                unacknowledgedSecret.current = null;
                setSecret(null);
                setSecretBlocked(false);
              }}
            >
              Dismiss secret
            </Button>
          </div>
        )}
        {editing ? (
          <RoutineEditor
            key={editing === "new" ? "new" : editing.id}
            agentId={agentId}
            routine={editing === "new" ? null : editing}
            connected={connected}
            flush={flush}
            secretPending={!!secret}
            onSecret={revealSecret}
            onPersisted={acceptSaved}
            onSaved={setEditing}
            onClose={() => void select(null)}
            onDeleted={(id) => {
              mutation.current++;
              clearMutationError(id);
              setState((current) => ({
                ...current,
                routines: current.routines.filter(
                  (routine) => routine.id !== id,
                ),
              }));
              setEditing(null);
            }}
          />
        ) : (
          <>
            {loading ? (
              <RoutineLoading />
            ) : !state.routines.length ? (
              <div className="routine-empty">
                <Clock3Icon size={24} aria-hidden />
                <p>No routines yet</p>
              </div>
            ) : (
              <div className="settings-group routine-list">
                {state.routines.map((routine) => (
                  <div className="settings-row routine-card" key={routine.id}>
                    <div className="routine-list-copy">
                      <Button
                        className="routine-list-title"
                        variant="ghost"
                        onClick={() => void select(routine)}
                      >
                        {routine.name}
                      </Button>
                      <p className="routine-list-instruction">
                        {routine.instruction}
                      </p>
                      <p className="routine-list-schedule">
                        <Clock3Icon size={12} aria-hidden />
                        {scheduleLabel(routine.trigger)} ·{" "}
                        {routine.enabled
                          ? routine.nextAt
                            ? formatRoutineTime(routine.nextAt)
                            : "Webhook"
                          : "Paused"}
                      </p>
                    </div>
                    <Switch
                      className="routine-card-switch"
                      aria-label={`Enable ${routine.name}`}
                      checked={routine.enabled}
                      disabled={!connected || savingIds.includes(routine.id)}
                      onCheckedChange={(enabled) =>
                        toggleRoutine(routine, enabled)
                      }
                    />
                  </div>
                ))}
              </div>
            )}
            {!!state.runs.length && (
              <>
                <h3 className="routine-section-title">Run history</h3>
                <div className="settings-group">
                  {state.runs.map((run) => (
                    <div className="settings-row routine-run-row" key={run.id}>
                      <span>
                        {state.routines.find(
                          (routine) => routine.id === run.routineId,
                        )?.name ?? "Deleted routine"}{" "}
                        · {new Date(run.createdAt).toLocaleString()}
                      </span>
                      <span className="routine-status" data-status={run.status}>
                        {run.status}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {(runCursors.length > 0 || state.nextRunCursor != null) && (
              <div className="routine-actions">
                <Button
                  disabled={loading || runCursors.length === 0}
                  onClick={() =>
                    setRunCursors((cursors) => cursors.slice(0, -1))
                  }
                >
                  Newer runs
                </Button>
                <Button
                  disabled={loading || state.nextRunCursor == null}
                  onClick={() => {
                    const cursor = state.nextRunCursor;

                    if (cursor != null)
                      setRunCursors((cursors) => [...cursors, cursor]);
                  }}
                >
                  Older runs
                </Button>
              </div>
            )}
            {!!state.events.length && (
              <details>
                <summary>Trigger history</summary>
                <ul>
                  {state.events.map((event) => (
                    <li key={event.id}>
                      {new Date(event.createdAt).toLocaleString()} ·{" "}
                      {event.outcome}
                      {event.deliveryId ? ` · ${event.deliveryId}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function RoutineEditor({
  agentId,
  routine,
  connected,
  flush,
  onSaved,
  onPersisted,
  onClose,
  onDeleted,
  secretPending,
  onSecret,
}: {
  agentId: string;
  routine: Routine | null;
  connected: boolean;
  flush: MutableRefObject<(() => Promise<void>) | null>;
  onSaved(routine: Routine): void;
  onPersisted(routine: Routine): void;
  onClose(): void;
  onDeleted(id: string): void;
  secretPending: boolean;
  onSecret(secret: WebhookSecret): void;
}) {
  const [draft, setDraft] = useState<SaveRoutine>(routine ?? defaultRoutine());
  const current = useRef(draft);
  const saved = useRef(routine ? JSON.stringify(draft) : "");
  const senderSecret = useRef("");
  const [secretDraft, setSecretDraft] = useState("");
  const version = useRef(routine?.revision);
  const routineId = useRef(routine?.id);
  const failedCreation = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const filters: RoutineFilterGroup =
    draft.trigger.kind === "webhook"
      ? draft.trigger.filters
      : { combinator: "and", rules: [] };
  const pendingRoutine = useRef<Routine | undefined>(undefined);
  const [customSchedule, setCustomSchedule] = useState(
    draft.trigger.kind === "cron" && !calendarParts(draft.trigger.expression),
  );
  const [payload, setPayload] = useState("{}");
  const [starting, setStarting] = useState(false);
  const [runQueued, setRunQueued] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState<readonly string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function change(next: Partial<SaveRoutine>) {
    if (next.trigger && next.trigger.kind !== "webhook") {
      senderSecret.current = "";
      setSecretDraft("");
    }

    current.current = { ...current.current, ...next };
    setDraft(current.current);
    setError(null);
  }

  function save() {
    if (inFlight.current) return inFlight.current;

    const task = (async () => {
      setPending(true);

      try {
        do {
          const next = current.current;

          if (saved.current === JSON.stringify(next) && !senderSecret.current)
            break;
          if (!connected) throw new Error("Reconnect to save your changes.");

          if (saved.current !== JSON.stringify(next)) {
            const result = await saveRoutine(
              agentId,
              next,
              routineId.current,
              version.current,
            );
            pendingRoutine.current = result.routine;
            routineId.current = result.routine.id;
            failedCreation.current = false;
            version.current = result.routine.revision;
            saved.current = JSON.stringify(next);
            onPersisted(result.routine);

            if (result.webhook) onSecret(result.webhook);
          }

          if (next.trigger.kind === "webhook" && senderSecret.current) {
            const secret = senderSecret.current;
            await routineRequest(
              `${routinePath(agentId, routineId.current!)}/rotate`,
              "POST",
              { secret },
            );

            if (senderSecret.current === secret) {
              senderSecret.current = "";
              setSecretDraft("");
            }
          }
        } while (
          saved.current !== JSON.stringify(current.current) ||
          !!senderSecret.current
        );

        if (pendingRoutine.current) {
          onSaved(pendingRoutine.current);
          pendingRoutine.current = undefined;
        }
      } catch (cause) {
        failedCreation.current = !routineId.current;
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save routine. Check filters and schedule.",
        );

        throw cause;
      } finally {
        setPending(false);
      }
    })().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = task;

    return task;
  }

  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const persist = async () => {
      if (inFlight.current) await inFlight.current;

      if (routineId.current) {
        await saveRef.current();
      } else if (failedCreation.current) {
        const message = "Create the routine or discard edits before leaving.";
        setError((current) => current ?? message);

        throw new Error(message);
      }
    };
    flush.current = persist;

    return () => {
      if (flush.current === persist) flush.current = null;
    };
  }, [flush, routine]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void routineRequest(
        `/api/routine-preview`,
        "POST",
        { trigger: draft.trigger },
        controller.signal,
      )
        .then((value) => {
          setPreview(
            Schema.decodeUnknownSync(Schema.Array(Schema.String))(value),
          );
          setPreviewError(null);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setPreview([]);
            setPreviewError(String(cause));
          }
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft.trigger]);

  function changeFilters(next: RoutineFilterGroup) {
    const trigger = current.current.trigger;

    if (trigger.kind === "webhook")
      change({ trigger: { ...trigger, filters: next } });
  }

  function blur() {
    if (routineId.current) void save().catch(() => {});
  }

  function runPendingOperation(operation: () => Promise<void>) {
    if (inFlight.current) return inFlight.current;

    setError(null);
    setPending(true);
    const task = operation()
      .catch((cause) => {
        setError(String(cause));

        throw cause;
      })
      .finally(() => {
        inFlight.current = null;
        setPending(false);
      });
    inFlight.current = task;

    return task;
  }

  async function runNow() {
    if (!routine || starting) return;

    setStarting(true);
    setRunQueued(false);
    setRunError(null);

    try {
      await save();
      await routineRequest(
        `${routinePath(agentId, routine.id)}/run`,
        "POST",
        current.current.trigger.kind === "webhook" ? { payload } : {},
      );
      setRunQueued(true);
    } catch (cause) {
      setRunError(
        cause instanceof Error
          ? cause.message
          : "Could not start run. Try again.",
      );
    } finally {
      setStarting(false);
    }
  }

  function remove() {
    if (!routine || inFlight.current || secretPending) return;

    void runPendingOperation(async () => {
      await routineRequest(routinePath(agentId, routine.id), "DELETE");
      saved.current = JSON.stringify(current.current);
      onDeleted(routine.id);
    }).catch(() => {});
  }

  function rotateSecret() {
    if (!routine || inFlight.current || secretPending) return;
    if (
      !window.confirm(
        "Rotate the webhook secret? Existing senders must use the new secret.",
      )
    )
      return;

    void runPendingOperation(async () => {
      const value = await routineRequest(
        `${routinePath(agentId, routine.id)}/rotate`,
        "POST",
      );

      onSecret(
        Schema.decodeUnknownSync(
          Schema.Struct({ endpoint: Schema.String, secret: Schema.String }),
        )(value),
      );
    })
      .then(() => saveRef.current())
      .catch(() => {});
  }

  async function discard() {
    if (!window.confirm("Discard unsaved routine edits?")) return;

    await inFlight.current?.catch(() => {});
    flush.current = null;
    onClose();
  }

  return (
    <div className="routine-editor">
      {error && (
        <>
          <p role="alert">{error}</p>
          <Button onClick={() => void discard()}>Discard edits</Button>
        </>
      )}
      <div className="settings-group routine-fields">
        <label className="settings-row">
          Name
          <Input
            value={draft.name}
            maxLength={80}
            onChange={(event) => change({ name: event.target.value })}
            onBlur={blur}
          />
        </label>
        <label className="settings-row">
          Instruction
          <Textarea
            value={draft.instruction}
            maxLength={32000}
            onChange={(event) => change({ instruction: event.target.value })}
            onBlur={blur}
          />
        </label>
        <label className="settings-row routine-enabled-row">
          Enabled
          <Switch
            checked={draft.enabled}
            disabled={!connected}
            onCheckedChange={(enabled) => {
              change({ enabled });
              blur();
            }}
          />
        </label>
        <label className="settings-row">
          Trigger
          <select
            disabled={pending || secretPending}
            value={draft.trigger.kind}
            onChange={(event) => {
              if (inFlight.current || secretPending) return;

              const kind = event.target.value;
              change({
                ...(kind === "once" ? { missed: "latest" as const } : {}),
                trigger:
                  kind === "once"
                    ? { kind, at: new Date(Date.now() + 3600000).toISOString() }
                    : kind === "interval"
                      ? { kind, minutes: 60 }
                      : kind === "webhook"
                        ? { kind, filters: { combinator: "and", rules: [] } }
                        : {
                            kind: "cron",
                            expression: "0 9 * * 1-5",
                            timezone:
                              Intl.DateTimeFormat().resolvedOptions().timeZone,
                          },
              });
              blur();
            }}
          >
            <option value="cron">Calendar</option>
            <option value="interval">Interval</option>
            <option value="once">One time</option>
            <option value="webhook">Webhook</option>
          </select>
        </label>
        {draft.trigger.kind === "cron" && (
          <>
            <label className="settings-row">
              Repeat
              <select
                value={
                  customSchedule
                    ? "custom"
                    : (calendarParts(draft.trigger.expression)?.repeat ??
                      "custom")
                }
                onChange={(event) => {
                  const repeat = event.target.value;
                  setCustomSchedule(repeat === "custom");

                  if (repeat === "custom" || draft.trigger.kind !== "cron")
                    return;

                  const parts = calendarParts(draft.trigger.expression);
                  change({
                    trigger: {
                      ...draft.trigger,
                      expression: `${parts?.minute ?? 0} ${parts?.hour ?? 9} * * ${repeat === "daily" ? "*" : repeat === "weekdays" ? "1-5" : "1"}`,
                    },
                  });
                  blur();
                }}
              >
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Every week</option>
                <option value="custom">Custom cron</option>
              </select>
            </label>
            {customSchedule ? (
              <label className="settings-row">
                Cron
                <Input
                  value={draft.trigger.expression}
                  onChange={(event) => {
                    if (draft.trigger.kind === "cron")
                      change({
                        trigger: {
                          ...draft.trigger,
                          expression: event.target.value,
                        },
                      });
                  }}
                  onBlur={blur}
                />
              </label>
            ) : (
              <>
                <label className="settings-row">
                  Time
                  <Input
                    type="time"
                    value={`${String(calendarParts(draft.trigger.expression)?.hour ?? 9).padStart(2, "0")}:${String(calendarParts(draft.trigger.expression)?.minute ?? 0).padStart(2, "0")}`}
                    onChange={(event) => {
                      if (draft.trigger.kind !== "cron" || !event.target.value)
                        return;

                      const [hour, minute] = event.target.value
                        .split(":")
                        .map(Number);
                      const parts = calendarParts(draft.trigger.expression);
                      change({
                        trigger: {
                          ...draft.trigger,
                          expression: `${minute} ${hour} * * ${parts?.day ?? "*"}`,
                        },
                      });
                    }}
                    onBlur={blur}
                  />
                </label>
                {calendarParts(draft.trigger.expression)?.repeat ===
                  "weekly" && (
                  <label className="settings-row">
                    Day
                    <select
                      value={calendarParts(draft.trigger.expression)?.day}
                      onChange={(event) => {
                        if (draft.trigger.kind !== "cron") return;

                        const parts = calendarParts(draft.trigger.expression);
                        change({
                          trigger: {
                            ...draft.trigger,
                            expression: `${parts?.minute ?? 0} ${parts?.hour ?? 9} * * ${event.target.value}`,
                          },
                        });
                        blur();
                      }}
                    >
                      {[
                        "Sunday",
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                      ].map((name, index) => (
                        <option key={name} value={index}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
            <label className="settings-row">
              Timezone
              <Input
                value={draft.trigger.timezone}
                list="routine-timezones"
                onChange={(event) => {
                  if (draft.trigger.kind === "cron")
                    change({
                      trigger: {
                        ...draft.trigger,
                        timezone: event.target.value,
                      },
                    });
                }}
                onBlur={blur}
              />
              <datalist id="routine-timezones">
                {Intl.supportedValuesOf("timeZone").map((timezone) => (
                  <option key={timezone} value={timezone} />
                ))}
              </datalist>
            </label>
          </>
        )}
        {draft.trigger.kind === "interval" && (
          <label className="settings-row">
            Minutes
            <Input
              type="number"
              min={1}
              value={draft.trigger.minutes}
              onChange={(event) =>
                change({
                  trigger: {
                    kind: "interval",
                    minutes: Number(event.target.value),
                  },
                })
              }
              onBlur={blur}
            />
          </label>
        )}
        {draft.trigger.kind === "once" && (
          <label className="settings-row">
            Date and time
            <Input
              type="datetime-local"
              value={localDateTime(draft.trigger.at)}
              onChange={(event) =>
                change({
                  trigger: {
                    kind: "once",
                    at: event.target.value
                      ? new Date(event.target.value).toISOString()
                      : "",
                  },
                })
              }
              onBlur={blur}
            />
          </label>
        )}
        {routine && draft.trigger.kind === "webhook" && (
          <label className="settings-row">
            Sender secret
            <Input
              type="password"
              autoComplete="new-password"
              aria-description="Paste a secret generated by your webhook sender to replace the current secret."
              disabled={!connected || secretPending}
              value={secretDraft}
              onChange={(event) => {
                senderSecret.current = event.target.value;
                setSecretDraft(event.target.value);
                setError(null);
              }}
              onBlur={blur}
            />
          </label>
        )}
        {draft.trigger.kind === "webhook" && (
          <div className="settings-row routine-filter-row">
            <span>Filters</span>
            <RoutineConditionBuilder
              filters={filters}
              onChange={changeFilters}
              onCommit={blur}
            />
          </div>
        )}
      </div>
      <details className="routine-advanced">
        <summary>Advanced</summary>
        <div className="settings-group routine-fields">
          <label className="settings-row">
            Missed executions
            <select
              value={draft.missed}
              onChange={(event) => {
                change({
                  missed: event.target.value === "latest" ? "latest" : "skip",
                });
                blur();
              }}
            >
              <option value="skip">Skip</option>
              <option value="latest">Run latest once</option>
            </select>
          </label>
          <label className="settings-row">
            Timeout (minutes)
            <Input
              type="number"
              min={1}
              max={1440}
              value={draft.timeoutMinutes}
              onChange={(event) =>
                change({ timeoutMinutes: Number(event.target.value) })
              }
              onBlur={blur}
            />
          </label>
        </div>
      </details>
      {previewError && <p role="alert">{previewError}</p>}
      {!!preview.length && (
        <details className="routine-upcoming">
          <summary>Next run {formatRoutineTime(preview[0]!)}</summary>
          <ul>
            {preview.slice(1).map((time) => (
              <li key={time}>{formatRoutineTime(time)}</li>
            ))}
          </ul>
        </details>
      )}
      {!routine ? (
        <Button
          disabled={
            pending || !connected || (secretPending && !routineId.current)
          }
          onClick={() => void save().catch(() => {})}
        >
          Create routine
        </Button>
      ) : (
        <>
          {draft.trigger.kind === "webhook" && (
            <label>
              Sample JSON payload
              <Textarea
                value={payload}
                onChange={(event) => setPayload(event.target.value)}
              />
            </label>
          )}
          <div className="routine-actions">
            <Button
              disabled={!connected || pending || starting}
              aria-busy={starting}
              onClick={() => void runNow()}
            >
              {starting ? (
                <Clock3Icon size={13} aria-hidden />
              ) : (
                <PlayIcon size={13} aria-hidden />
              )}
              {starting ? "Starting…" : "Run now"}
            </Button>
            {runQueued && (
              <span className="routine-run-feedback" role="status">
                <CheckIcon size={14} aria-hidden />
                Run queued
              </span>
            )}
            {draft.trigger.kind === "webhook" && (
              <Button
                disabled={!connected || pending || secretPending}
                onClick={rotateSecret}
              >
                Rotate webhook secret
              </Button>
            )}
            <Button
              variant="ghost"
              className="routine-delete"
              disabled={!connected || pending || secretPending}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon size={13} aria-hidden />
              Delete routine
            </Button>
          </div>
          {runError && <p role="alert">{runError}</p>}
          {confirmDelete && (
            <div role="alertdialog" aria-label="Delete routine">
              <p>Delete this routine and stop its queued and running work?</p>
              <Button onClick={() => setConfirmDelete(false)}>
                Keep routine
              </Button>
              <Button
                variant="destructive"
                disabled={!connected || pending || secretPending}
                onClick={remove}
              >
                Confirm deletion
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
