import {
  CheckIcon,
  CopyIcon,
  Clock3Icon,
  PlusIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { Switch } from "../components/ui/switch.tsx";
import {
  useEffect,
  useRef,
  useState,
  useId,
  type FocusEvent,
  type MutableRefObject,
} from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  activeEnvironmentId,
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
import { routineValidation, type RoutineField } from "./routineValidation.ts";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "../components/ui/alert-dialog.tsx";
import "./routines.css";

class RoutineValidationError extends Error {}

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
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const flush = useRef<(() => Promise<void>) | null>(null);
  const mutation = useRef(0);
  const listSaves = useRef(new Map<string, Promise<Routine>>());
  const [savingIds, setSavingIds] = useState<readonly string[]>([]);

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
        {loadError && <p role="alert">{loadError}</p>}
        {[...mutationErrors].map(([id, message]) => (
          <p key={id} role="alert">
            {message}
          </p>
        ))}
        {webhookSecret && (
          <div className="settings-group routine-fields">
            <label className="settings-row">
              Webhook secret
              <Input readOnly value={webhookSecret} />
            </label>
            <div className="routine-secret-footer">
              <p>
                Shown once. Send it in the Authorization header as Bearer
                followed by this secret.
              </p>
              <Button onClick={() => setWebhookSecret(null)}>
                Dismiss secret
              </Button>
            </div>
          </div>
        )}
        {editing ? (
          <RoutineEditor
            key={editing === "new" ? "new" : editing.id}
            agentId={agentId}
            routine={editing === "new" ? null : editing}
            connected={connected}
            events={state.events.filter(
              (event) => editing !== "new" && event.routineId === editing.id,
            )}
            flush={flush}
            onSecret={setWebhookSecret}
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
          </>
        )}
      </div>
    </section>
  );
}

const activityLabels: Record<string, string> = {
  accepted: "Webhook received",
  filtered: "Event skipped",
  duplicate: "Duplicate ignored",
  deleted: "Routine deleted",
  secret_rotated: "Secret regenerated",
  rejected_authentication: "Invalid webhook secret",
  rejected_paused: "Routine paused",
  rejected_payload: "Invalid payload",
  rejected_queue: "Queue full",
  queue_full: "Queue full",
  missed_schedule_skipped: "Missed schedule skipped",
  combined_scheduled_tick: "Scheduled run combined",
  "notification:waiting": "Waiting for your response",
  "notification:failed": "Run failed",
  "notification:expired": "Run expired",
  "notification:interrupted": "Run interrupted",
};

function RoutineActivity({ events }: { events: State["events"] }) {
  if (!events.length) return null;

  const groups = new Map<string, State["events"][number][]>();
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  });
  const timeFormat = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  for (const event of events) {
    const day = dateFormat.format(new Date(event.createdAt));
    const group = groups.get(day);

    if (group) group.push(event);
    else groups.set(day, [event]);
  }

  return (
    <details className="routine-activity">
      <summary>
        <ChevronRightIcon size={14} aria-hidden />
        <span>Activity</span>
      </summary>
      <div className="settings-group routine-activity-groups">
        {[...groups].map(([day, entries]) => (
          <section className="routine-activity-day" key={day}>
            <h4>{day}</h4>
            <ul aria-label={`Activity on ${day}`}>
              {entries.map((event) => {
                const label =
                  activityLabels[event.outcome] ??
                  event.outcome.replaceAll("_", " ").replaceAll(":", " · ");
                const Icon =
                  event.outcome === "secret_rotated"
                    ? KeyRoundIcon
                    : event.outcome === "deleted"
                      ? Trash2Icon
                      : Clock3Icon;

                return (
                  <li key={event.id}>
                    <Icon size={14} aria-hidden />
                    <span className="routine-activity-label">{label}</span>
                    <time
                      dateTime={event.createdAt}
                      title={new Date(event.createdAt).toLocaleString()}
                    >
                      {timeFormat.format(new Date(event.createdAt))}
                    </time>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </details>
  );
}

function RoutineEditor({
  events,
  agentId,
  routine,
  connected,
  flush,
  onSaved,
  onSecret,
  onPersisted,
  onClose,
  onDeleted,
}: {
  events: State["events"];
  agentId: string;
  routine: Routine | null;
  connected: boolean;
  flush: MutableRefObject<(() => Promise<void>) | null>;
  onSaved(routine: Routine): void;
  onSecret(secret: string): void;
  onPersisted(routine: Routine): void;
  onClose(): void;
  onDeleted(id: string): void;
}) {
  const [draft, setDraft] = useState<SaveRoutine>(routine ?? defaultRoutine());
  const validationId = useId();
  const [showValidation, setShowValidation] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const validation = routineValidation(draft);

  function fieldError(field: RoutineField) {
    return showValidation || touched.has(field) ? validation[field] : undefined;
  }

  function fieldProps(field: RoutineField, label: string) {
    return {
      "aria-label": label,
      "aria-invalid": !!fieldError(field),
      "aria-describedby": fieldError(field)
        ? `${validationId}-${field}`
        : undefined,
      "data-routine-field": field,
    };
  }

  function feedback(field: RoutineField) {
    const message = fieldError(field);

    return message ? (
      <span
        className="routine-field-error"
        id={`${validationId}-${field}`}
        role="alert"
      >
        {message}
      </span>
    ) : null;
  }

  const current = useRef(draft);
  const saved = useRef(routine ? JSON.stringify(draft) : "");
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
  const keepRoutineRef = useRef<HTMLButtonElement>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const keepSecretRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<readonly string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const remoteEnvironment = !!activeEnvironmentId();
  const webhookUrlId = useId();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const webhookDisplayUrl =
    !remoteEnvironment && webhookUrl
      ? new URL(webhookUrl, window.location.origin).href
      : "";
  const webhookId =
    routine?.trigger.kind === "webhook" ? routine.id : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setWebhookUrl("");
    setWebhookError(null);

    if (webhookId && !remoteEnvironment) {
      void routineRequest(
        `${routinePath(agentId, webhookId)}/webhook`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((value) => {
          if (controller.signal.aborted) return;

          setWebhookUrl(
            Schema.decodeUnknownSync(
              Schema.Struct({ endpoint: Schema.String }),
            )(value).endpoint,
          );
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setWebhookError(String(cause));
        });
    }

    return () => controller.abort();
  }, [agentId, webhookId, remoteEnvironment]);

  useEffect(() => {
    if (copiedAt === null) return;

    const timer = setTimeout(() => setCopiedAt(null), 2000);

    return () => clearTimeout(timer);
  }, [copiedAt]);

  async function copyWebhookUrl() {
    setCopyError(null);
    setCopiedAt(null);

    try {
      await navigator.clipboard.writeText(webhookDisplayUrl);
      setCopiedAt(Date.now());
    } catch {
      setCopyError("Could not copy URL. Select the URL and copy it manually.");
    }
  }

  function regenerateWebhookSecret() {
    if (!webhookId || inFlight.current) return;

    void runPendingOperation(async () => {
      const value = await routineRequest(
        `${routinePath(agentId, webhookId)}/webhook`,
        "POST",
      );
      const webhook = Schema.decodeUnknownSync(
        Schema.Struct({ endpoint: Schema.String, secret: Schema.String }),
      )(value);
      setWebhookUrl(webhook.endpoint);
      onSecret(webhook.secret);
      setWebhookError(null);
      setConfirmRegenerate(false);
    })
      .then(() => saveRef.current())
      .catch(() => {});
  }

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

          if (Object.keys(routineValidation(next)).length) {
            setShowValidation(true);

            throw new RoutineValidationError("Correct the highlighted fields.");
          }

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

          if (result.webhook) onSecret(result.webhook.secret);
        } while (saved.current !== JSON.stringify(current.current));

        if (pendingRoutine.current) {
          onSaved(pendingRoutine.current);
          pendingRoutine.current = undefined;
        }
      } catch (cause) {
        if (cause instanceof RoutineValidationError) {
          setError(null);
        } else {
          failedCreation.current = !routineId.current;
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not save routine. Check filters and schedule.",
          );
        }

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

  function blur(event?: FocusEvent<HTMLElement>) {
    const field = event?.currentTarget.dataset.routineField;

    if (field) setTouched((current) => new Set([...current, field]));

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
    if (!routine || inFlight.current) return;

    void runPendingOperation(async () => {
      await routineRequest(routinePath(agentId, routine.id), "DELETE");
      saved.current = JSON.stringify(current.current);
      onDeleted(routine.id);
    }).catch(() => {});
  }

  async function discard() {
    if (!window.confirm("Discard unsaved routine edits?")) return;

    await inFlight.current?.catch(() => {});
    flush.current = null;
    onClose();
  }

  return (
    <div className="routine-editor">
      {(error ||
        (routineId.current &&
          showValidation &&
          Object.keys(validation).length > 0)) && (
        <>
          {error && <p role="alert">{error}</p>}
          <Button onClick={() => void discard()}>Discard edits</Button>
        </>
      )}
      <div className="settings-group routine-fields">
        <label className="settings-row">
          Name
          <Input
            {...fieldProps("name", "Name")}
            value={draft.name}
            maxLength={80}
            onChange={(event) => change({ name: event.target.value })}
            onBlur={blur}
          />
          {feedback("name")}
        </label>
        <label className="settings-row">
          Instruction
          <Textarea
            {...fieldProps("instruction", "Instruction")}
            value={draft.instruction}
            maxLength={32000}
            onChange={(event) => change({ instruction: event.target.value })}
            onBlur={blur}
          />
          {feedback("instruction")}
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
            disabled={pending}
            value={draft.trigger.kind}
            onChange={(event) => {
              if (inFlight.current) return;

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
                  {...fieldProps("expression", "Cron")}
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
                {feedback("expression")}
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
                {...fieldProps("timezone", "Timezone")}
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
              {feedback("timezone")}
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
              {...fieldProps("minutes", "Minutes")}
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
            {feedback("minutes")}
          </label>
        )}
        {draft.trigger.kind === "once" && (
          <label className="settings-row">
            Date and time
            <Input
              type="datetime-local"
              {...fieldProps("at", "Date and time")}
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
            {feedback("at")}
          </label>
        )}
        {routine && draft.trigger.kind === "webhook" && (
          <div className="settings-row">
            {remoteEnvironment ? (
              <span>Webhook URL</span>
            ) : (
              <label htmlFor={webhookUrlId}>Webhook URL</label>
            )}
            <div className="routine-webhook-controls">
              {remoteEnvironment ? (
                <span>
                  Open Paws on the owning machine to copy its webhook URL.
                </span>
              ) : (
                <div
                  className="routine-webhook-url"
                  data-copied={copiedAt !== null}
                >
                  <Input
                    id={webhookUrlId}
                    readOnly
                    value={webhookDisplayUrl}
                    aria-busy={!webhookUrl && !webhookError}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      copiedAt !== null
                        ? "Copied webhook URL"
                        : "Copy webhook URL"
                    }
                    title={copiedAt !== null ? "Copied" : "Copy webhook URL"}
                    disabled={!webhookDisplayUrl}
                    onClick={() => void copyWebhookUrl()}
                  >
                    {copiedAt !== null ? (
                      <CheckIcon size={14} aria-hidden />
                    ) : (
                      <CopyIcon size={14} aria-hidden />
                    )}
                  </Button>
                  {copiedAt !== null && (
                    <span className="routine-copy-feedback" role="status">
                      Copied
                    </span>
                  )}
                </div>
              )}
              <Button
                variant="outline"
                disabled={!connected || pending}
                onClick={() => {
                  setError(null);
                  setConfirmRegenerate(true);
                }}
              >
                Regenerate secret
              </Button>
              {webhookError && <p role="alert">{webhookError}</p>}
              {copyError && <p role="alert">{copyError}</p>}
            </div>
          </div>
        )}
        {draft.trigger.kind === "webhook" && (
          <div className="settings-row routine-filter-row">
            <span>Filters</span>
            <RoutineConditionBuilder
              filters={filters}
              onChange={changeFilters}
              onCommit={blur}
              showErrors={showValidation}
            />
            {feedback("filters")}
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
              {...fieldProps("timeoutMinutes", "Timeout (minutes)")}
              value={draft.timeoutMinutes}
              onChange={(event) =>
                change({ timeoutMinutes: Number(event.target.value) })
              }
              onBlur={blur}
            />
            {feedback("timeoutMinutes")}
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
          {runError && <p role="alert">{runError}</p>}
          <AlertDialog
            open={confirmRegenerate}
            onOpenChange={(open) => {
              if (!pending) setConfirmRegenerate(open);
            }}
          >
            <AlertDialogPopup initialFocus={keepSecretRef}>
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate webhook secret?</AlertDialogTitle>
                <AlertDialogDescription>
                  The current secret will stop working. Update your sender with
                  the new secret, which is shown once.
                </AlertDialogDescription>
                {error && <p role="alert">{error}</p>}
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Button
                  ref={keepSecretRef}
                  variant="outline"
                  disabled={pending}
                  onClick={() => setConfirmRegenerate(false)}
                >
                  Keep secret
                </Button>
                <Button
                  variant="destructive"
                  disabled={!connected || pending}
                  aria-busy={pending}
                  onClick={regenerateWebhookSecret}
                >
                  {pending ? "Regenerating…" : "Regenerate secret"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <AlertDialog
            open={confirmDelete}
            onOpenChange={(open) => {
              if (!pending) setConfirmDelete(open);
            }}
          >
            <AlertDialogPopup initialFocus={keepRoutineRef}>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {draft.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will stop its queued and running work. This action cannot
                  be undone.
                </AlertDialogDescription>
                {error && <p role="alert">{error}</p>}
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Button
                  ref={keepRoutineRef}
                  variant="outline"
                  disabled={pending}
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep routine
                </Button>
                <Button
                  variant="destructive"
                  disabled={!connected || pending}
                  aria-busy={pending}
                  onClick={remove}
                >
                  {pending ? "Deleting…" : "Confirm deletion"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      )}
      <RoutineActivity events={events} />
    </div>
  );
}
