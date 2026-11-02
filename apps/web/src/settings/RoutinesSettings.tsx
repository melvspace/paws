import {
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
  loadRoutineRun,
  saveRoutine,
  routinePath,
  routineRequest,
} from "@paws/client-runtime";
import { Schema } from "effect";
import {
  type Routine,
  type SaveRoutine,
  RoutineState,
  type RoutineRun,
  type RoutineFilter,
} from "@paws/contracts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import "./routines.css";

type State = typeof RoutineState.Type;
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
  if (trigger.kind === "webhook")
    return trigger.eventType ? `Webhook · ${trigger.eventType}` : "Webhook";

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
  initialRunId,
  onBack,
}: {
  beforeClose: MutableRefObject<(() => Promise<void>) | null>;
  agentId: string;
  initialRunId?: string | undefined;
  onBack: () => void;
}) {
  const { snapshot, connected } = useAtomValue(agentsAtom);
  const [state, setState] = useState<State>(empty);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [selectedRun, setSelectedRun] = useState<RoutineRun | null>(null);
  const [runCursors, setRunCursors] = useState<readonly number[]>([]);
  const runCursor = runCursors.at(-1);
  const [secret, setSecret] = useState<{
    endpoint: string;
    secret: string;
  } | null>(null);
  const initialRun = useRef(initialRunId);
  const flush = useRef<(() => Promise<void>) | null>(null);
  const mutation = useRef(0);
  const listSaves = useRef(new Map<string, Promise<Routine>>());
  const [savingIds, setSavingIds] = useState<readonly string[]>([]);

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

        return saved;
      })
      .finally(() => {
        listSaves.current.delete(routine.id);
        setSavingIds((current) => current.filter((id) => id !== routine.id));
      });
    listSaves.current.set(routine.id, task);
    void task.catch((cause) => setError(String(cause)));
  }

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    async function refresh() {
      const startedAtMutation = mutation.current;

      try {
        const next = await loadRoutines(agentId, controller.signal, runCursor);
        const requestedId = initialRun.current ?? selectedRun?.id;
        const linked = requestedId
          ? (next.runs.find((item) => item.id === requestedId) ??
            (await loadRoutineRun(requestedId, controller.signal)))
          : undefined;

        if (linked && linked.agentId !== agentId)
          throw new Error("This run belongs to another agent.");

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
          setError(null);

          if (linked) {
            setSelectedRun(linked);
            initialRun.current = undefined;
          }
        }
      } catch (cause) {
        if (active)
          setError(
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
  }, [agentId, runCursor, selectedRun?.id]);

  useEffect(() => {
    const save = async () => {
      await Promise.all(listSaves.current.values());
      await flush.current?.();
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
      setSelectedRun(null);
    } catch {
      /* Keep failed edits visible. */
    }
  }

  if (!snapshot.agents.length) return <p>Create an agent to add routines.</p>;

  const detail = editing !== null || selectedRun !== null;
  const title =
    editing === "new"
      ? "New routine"
      : editing
        ? editing.name
        : selectedRun
          ? "Run details"
          : "Routines";

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
            disabled={!connected}
            onClick={() => void select("new")}
          >
            <PlusIcon size={14} aria-hidden />
            New
          </Button>
        )}
      </nav>
      <div className="routine-agent-panel">
        {!connected && <p role="status">Reconnecting…</p>}
        {error && <p role="alert">{error}</p>}
        {secret && (
          <div className="settings-group routine-secret">
            <p>Copy this signing secret now. It is shown once.</p>
            <label>
              Endpoint
              <Input readOnly value={secret.endpoint} />
            </label>
            <label>
              Signing secret
              <Input readOnly value={secret.secret} />
            </label>
            <p>
              POST JSON with X-Paws-Timestamp (Unix seconds), X-Paws-Signature
              (hex HMAC-SHA256 of timestamp + “.” + raw body), and optional
              X-Paws-Delivery-Id. Public delivery requires your configured
              ingress.
            </p>
            <Button onClick={() => setSecret(null)}>Dismiss secret</Button>
          </div>
        )}
        {editing ? (
          <RoutineEditor
            key={editing === "new" ? "new" : editing.id}
            agentId={agentId}
            routine={editing === "new" ? null : editing}
            connected={connected}
            flush={flush}
            onSaved={(routine, webhook) => {
              acceptSaved(routine);
              setEditing(routine);

              if (webhook) setSecret(webhook);
            }}
            onClose={() => void select(null)}
            onDeleted={(id) => {
              mutation.current++;
              setState((current) => ({
                ...current,
                routines: current.routines.filter(
                  (routine) => routine.id !== id,
                ),
              }));
              setEditing(null);
            }}
          />
        ) : selectedRun ? (
          <RunDetails
            run={
              state.runs.find((item) => item.id === selectedRun.id) ??
              selectedRun
            }
            connected={connected}
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
                      <Button
                        variant="ghost"
                        onClick={() => setSelectedRun(run)}
                      >
                        {state.routines.find(
                          (routine) => routine.id === run.routineId,
                        )?.name ?? "Deleted routine"}{" "}
                        · {new Date(run.createdAt).toLocaleString()}
                      </Button>
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
  onClose,
  onDeleted,
}: {
  agentId: string;
  routine: Routine | null;
  connected: boolean;
  flush: MutableRefObject<(() => Promise<void>) | null>;
  onSaved(
    routine: Routine,
    webhook?: { endpoint: string; secret: string },
  ): void;
  onClose(): void;
  onDeleted(id: string): void;
}) {
  const [draft, setDraft] = useState<SaveRoutine>(routine ?? defaultRoutine());
  const current = useRef(draft);
  const saved = useRef(routine ? JSON.stringify(draft) : "");
  const version = useRef(routine?.revision);
  const routineId = useRef(routine?.id);
  const inFlight = useRef<Promise<void> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const filters = draft.trigger.kind === "webhook" ? draft.trigger.filters : [];
  const pendingRoutine = useRef<Routine | undefined>(undefined);
  const pendingWebhook =
    useRef<Awaited<ReturnType<typeof saveRoutine>>["webhook"]>(undefined);
  const [customSchedule, setCustomSchedule] = useState(
    draft.trigger.kind === "cron" && !calendarParts(draft.trigger.expression),
  );
  const [payload, setPayload] = useState("{}");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState<readonly string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function change(next: Partial<SaveRoutine>) {
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

          if (saved.current === JSON.stringify(next)) break;
          if (!connected) throw new Error("Reconnect to save your changes.");

          const result = await saveRoutine(
            agentId,
            next,
            routineId.current,
            version.current,
          );
          pendingRoutine.current = result.routine;
          routineId.current = result.routine.id;
          version.current = result.routine.revision;
          pendingWebhook.current =
            result.routine.trigger.kind === "webhook"
              ? (result.webhook ?? pendingWebhook.current)
              : undefined;
          saved.current = JSON.stringify(next);
        } while (saved.current !== JSON.stringify(current.current));

        if (pendingRoutine.current) {
          onSaved(pendingRoutine.current, pendingWebhook.current);
          pendingRoutine.current = undefined;
          pendingWebhook.current = undefined;
        }
      } catch (cause) {
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
      if (routineId.current) await saveRef.current();
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

  function changeFilters(next: readonly RoutineFilter[]) {
    const trigger = current.current.trigger;

    if (trigger.kind === "webhook")
      change({ trigger: { ...trigger, filters: next } });
  }

  function blur() {
    if (routineId.current) void save().catch(() => {});
  }

  function remove() {
    if (!routine || inFlight.current) return;

    setPending(true);
    const task = routineRequest(routinePath(agentId, routine.id), "DELETE")
      .then(() => {
        saved.current = JSON.stringify(current.current);
        onDeleted(routine.id);
      })
      .catch((cause) => {
        setError(String(cause));

        throw cause;
      })
      .finally(() => {
        inFlight.current = null;
        setPending(false);
      });
    inFlight.current = task;
    void task.catch(() => {});
  }

  return (
    <div className="routine-editor">
      {error && (
        <>
          <p role="alert">{error}</p>
          <Button
            onClick={() => {
              if (!window.confirm("Discard unsaved routine edits?")) return;

              flush.current = null;
              onClose();
            }}
          >
            Discard edits
          </Button>
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
            value={draft.trigger.kind}
            onChange={(event) => {
              const kind = event.target.value;
              change({
                ...(kind === "once" ? { missed: "latest" as const } : {}),
                trigger:
                  kind === "once"
                    ? { kind, at: new Date(Date.now() + 3600000).toISOString() }
                    : kind === "interval"
                      ? { kind, minutes: 60 }
                      : kind === "webhook"
                        ? { kind, filters: [] }
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
        {draft.trigger.kind === "webhook" && (
          <>
            <label className="settings-row">
              Event type
              <Input
                value={draft.trigger.eventType ?? ""}
                onChange={(event) => {
                  if (draft.trigger.kind === "webhook")
                    change({
                      trigger: {
                        ...draft.trigger,
                        eventType: event.target.value || undefined,
                      },
                    });
                }}
                onBlur={blur}
              />
            </label>
            <div className="settings-row routine-filter-row">
              <span>Filters</span>
              <div className="routine-filter-list">
                {filters.map((filter, index) => (
                  <div className="routine-filter" key={index}>
                    <label>
                      Field
                      <Input
                        value={filter.path}
                        onChange={(event) =>
                          changeFilters(
                            filters.map((item, position) =>
                              position === index
                                ? { ...item, path: event.target.value }
                                : item,
                            ),
                          )
                        }
                        onBlur={blur}
                      />
                    </label>
                    <label>
                      Condition
                      <select
                        value={filter.operator}
                        onChange={(event) => {
                          const operator =
                            event.target.value === "exists"
                              ? "exists"
                              : event.target.value === "in"
                                ? "in"
                                : "equals";
                          changeFilters(
                            filters.map((item, position) =>
                              position === index ? { ...item, operator } : item,
                            ),
                          );
                          blur();
                        }}
                      >
                        <option value="equals">Equals</option>
                        <option value="in">Is one of</option>
                        <option value="exists">Exists</option>
                      </select>
                    </label>
                    {filter.operator !== "exists" && (
                      <label>
                        {filter.operator === "in"
                          ? "Values, comma-separated"
                          : "Value"}
                        <Input
                          value={filter.value ?? ""}
                          onChange={(event) =>
                            changeFilters(
                              filters.map((item, position) =>
                                position === index
                                  ? { ...item, value: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          onBlur={blur}
                        />
                      </label>
                    )}
                    <Button
                      variant="ghost"
                      aria-label={`Remove filter ${index + 1}`}
                      onClick={() => {
                        changeFilters(
                          filters.filter((_, position) => position !== index),
                        );
                        blur();
                      }}
                    >
                      <Trash2Icon size={13} aria-hidden />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  onClick={() =>
                    changeFilters([
                      ...filters,
                      { path: "", operator: "equals", value: "" },
                    ])
                  }
                >
                  <PlusIcon size={13} aria-hidden />
                  Add filter
                </Button>
              </div>
            </div>
          </>
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
          disabled={pending || !connected}
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
              disabled={!connected || pending}
              onClick={() =>
                void save()
                  .then(() =>
                    routineRequest(
                      `${routinePath(agentId, routine.id)}/run`,
                      "POST",
                      draft.trigger.kind === "webhook" ? { payload } : {},
                    ),
                  )
                  .catch((cause) => setError(String(cause)))
              }
            >
              <PlayIcon size={13} aria-hidden />
              Run now
            </Button>
            {draft.trigger.kind === "webhook" && (
              <Button
                disabled={!connected || pending}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Rotate the signing secret? Existing senders must use the new secret.",
                    )
                  )
                    return;
                  void routineRequest(
                    `${routinePath(agentId, routine.id)}/rotate`,
                    "POST",
                  )
                    .then((value) =>
                      onSaved(
                        routine,
                        Schema.decodeUnknownSync(
                          Schema.Struct({
                            endpoint: Schema.String,
                            secret: Schema.String,
                          }),
                        )(value),
                      ),
                    )
                    .catch((cause) => setError(String(cause)));
                }}
              >
                Rotate signing secret
              </Button>
            )}
            <Button
              variant="ghost"
              className="routine-delete"
              disabled={!connected || pending}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon size={13} aria-hidden />
              Delete routine
            </Button>
          </div>
          {confirmDelete && (
            <div role="alertdialog" aria-label="Delete routine">
              <p>Delete this routine and stop its queued and running work?</p>
              <Button onClick={() => setConfirmDelete(false)}>
                Keep routine
              </Button>
              <Button
                variant="destructive"
                disabled={!connected || pending}
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

function RunDetails({
  run,
  connected,
}: {
  run: RoutineRun;
  connected: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <p>
        {run.status} · {new Date(run.createdAt).toLocaleString()}
      </p>
      {run.error && <p role="alert">{run.error}</p>}
      <div className="routine-actions">
        {["queued", "running", "waiting"].includes(run.status) && (
          <Button
            disabled={!connected}
            onClick={() =>
              void routineRequest(
                `/api/routine-runs/${run.id}/cancel`,
                "POST",
              ).catch((cause) => setError(String(cause)))
            }
          >
            Cancel run
          </Button>
        )}
        {["failed", "interrupted", "expired", "cancelled"].includes(
          run.status,
        ) && (
          <Button
            disabled={!connected}
            onClick={() => {
              if (
                run.payload &&
                !window.confirm(
                  "Retry using this previously accepted payload? Completed actions may be repeated.",
                )
              )
                return;
              void routineRequest(`/api/routine-runs/${run.id}/retry`, "POST", {
                routineId: run.routineId,
                ...(run.payload ? { payload: run.payload } : {}),
              }).catch((cause) => setError(String(cause)));
            }}
          >
            Retry
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
