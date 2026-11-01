import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ChevronRightIcon,
  ArrowLeftIcon,
  PlusIcon,
  Trash2Icon,
  PlugIcon,
} from "lucide-react";
import type { TeamIntegration } from "@paws/contracts";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Button } from "./components/ui/button.tsx";

export function TeamIntegrations({
  value,
  onChange,
  teamId,
  disabled,
  beforeClose,
}: {
  value: readonly TeamIntegration[];
  onChange(value: readonly TeamIntegration[]): Promise<void>;
  teamId: string;
  beforeClose?: RefObject<(() => Promise<void>) | null> | undefined;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState<{
    item: TeamIntegration;
    existing: boolean;
  } | null>(null);
  if (editing)
    return (
      <IntegrationEditor
        key={editing.item.id}
        beforeClose={beforeClose}
        initial={editing.item}
        existing={editing.existing}
        teamId={teamId}
        disabled={disabled}
        onBack={() => setEditing(null)}
        onPersist={async (item, creating) => {
          if (creating && value.some((entry) => entry.id === item.id)) {
            throw new Error("An integration with this name already exists.");
          }

          await onChange([
            ...value.filter((entry) => entry.id !== item.id),
            item,
          ]);
        }}
        onRemove={async () => {
          await onChange(value.filter((entry) => entry.id !== editing.item.id));
          setEditing(null);
        }}
      />
    );

  return (
    <div className="team-integrations">
      <div className="team-page-toolbar">
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() =>
            setEditing({
              item: { id: "", kind: "cli", command: "", args: [] },
              existing: false,
            })
          }
        >
          <PlusIcon size={14} />
          New integration
        </Button>
      </div>
      {!!value.length && (
        <div className="settings-group team-collection">
          {value.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              className="team-collection-row"
              onClick={() => {
                setEditing({ item, existing: true });
              }}
            >
              <PlugIcon size={16} />
              <span>{item.id}</span>
              <span className="team-row-meta">
                {item.kind === "cli"
                  ? "CLI"
                  : item.kind === "mcp-http"
                    ? "Remote MCP"
                    : "Local MCP"}
              </span>
              <ChevronRightIcon size={16} />
            </Button>
          ))}
        </div>
      )}
      {!value.length && <p className="team-empty">No integrations</p>}
    </div>
  );
}

function IntegrationEditor({
  initial,
  existing,
  teamId,
  disabled,
  onBack,
  onPersist,
  onRemove,
  beforeClose,
}: {
  initial: TeamIntegration;
  existing: boolean;
  teamId: string;
  disabled: boolean;
  beforeClose?: RefObject<(() => Promise<void>) | null> | undefined;
  onBack(): void;
  onPersist(item: TeamIntegration, creating: boolean): Promise<void>;
  onRemove(): Promise<void>;
}) {
  const [configured, setConfigured] = useState(existing);
  const configuredRef = useRef(existing);
  const [draft, setDraft] = useState(initial);
  const draftRef = useRef(initial);
  const [args, setArgs] = useState(initial.args?.join("\n") ?? "");
  const [credentialName, setCredentialName] = useState(
    initial.kind === "mcp-http" ? "BEARER_TOKEN" : "",
  );
  const [credential, setCredential] = useState("");
  const credentialRef = useRef("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const flight = useRef<Promise<void> | null>(null);
  const saved = useRef(initial);

  function change(patch: Partial<TeamIntegration>) {
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
    setError("");
  }

  function save(): Promise<void> {
    if (flight.current) return flight.current;

    const request = (async () => {
      setPending(true);
      setError("");

      try {
        while (
          !configuredRef.current ||
          JSON.stringify(saved.current) !== JSON.stringify(draftRef.current) ||
          credentialRef.current
        ) {
          if (
            !configuredRef.current ||
            JSON.stringify(saved.current) !== JSON.stringify(draftRef.current)
          ) {
            const next = draftRef.current;
            await onPersist(next, !configuredRef.current);
            saved.current = next;
            configuredRef.current = true;
            setConfigured(true);
          }

          const secret = credentialRef.current;

          if (secret) {
            const key =
              draftRef.current.kind === "mcp-http"
                ? "BEARER_TOKEN"
                : credentialName;

            if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(key))
              throw new Error(
                "Enter an environment variable for this credential.",
              );

            const response = await fetch(
              `/api/teams/${encodeURIComponent(teamId)}/integrations/${encodeURIComponent(draftRef.current.id)}/credentials`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: key,
                  value: secret,
                  expectedIntegration: saved.current,
                }),
              },
            );

            if (!response.ok)
              throw new Error(
                response.status === 409
                  ? "Integration changed. Return to the team list and reopen it before entering credentials."
                  : "Could not save authentication. Try again.",
              );

            if (credentialRef.current === secret) {
              credentialRef.current = "";
              setCredential("");
            }
          }
        }
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save integration.",
        );

        throw cause;
      } finally {
        setPending(false);
      }
    })().finally(() => {
      flight.current = null;
    });
    flight.current = request;

    return request;
  }

  const flushRef = useRef(save);
  useEffect(() => {
    flushRef.current = save;
  });
  useEffect(() => {
    if (!beforeClose) return;

    const previous = beforeClose.current;
    const flush = async () => {
      if (flight.current) await flight.current;
      else if (configuredRef.current) await flushRef.current();

      await previous?.();
    };
    beforeClose.current = flush;

    return () => {
      if (beforeClose.current === flush) beforeClose.current = previous;
    };
  }, [beforeClose]);

  function autosave() {
    if (configuredRef.current) void save().catch(() => {});
  }

  return (
    <div className="integration-editor">
      <div className="team-detail-heading">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to integrations"
          onClick={() => {
            if (flight.current || configuredRef.current)
              void (flight.current ?? save()).then(onBack).catch(() => {});
            else onBack();
          }}
        >
          <ArrowLeftIcon size={16} />
        </Button>
        <span>{configured ? draft.id : "New integration"}</span>
        {existing && (
          <Button
            className="danger-button"
            variant="ghost"
            size="icon"
            aria-label="Remove integration"
            disabled={pending || disabled}
            onClick={() => {
              setPending(true);
              void onRemove().catch(() => {
                setError("Could not remove integration.");
                setPending(false);
              });
            }}
          >
            <Trash2Icon size={16} />
          </Button>
        )}
      </div>
      <form
        className="team-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save()
            .then(() => {
              if (!existing) onBack();
            })
            .catch(() => {});
        }}
      >
        <fieldset
          disabled={disabled || (!configured && pending)}
          className="settings-group team-collection"
        >
          {!configured && (
            <div className="settings-row">
              <label htmlFor="integration-id">Name</label>
              <Input
                id="integration-id"
                value={draft.id}
                onChange={(event) => change({ id: event.target.value })}
                required
                pattern="[a-z][a-z0-9-]{0,63}"
              />
            </div>
          )}
          <div className="settings-row">
            <label htmlFor="integration-kind">Connection</label>
            <select
              id="integration-kind"
              value={draft.kind}
              onChange={(event) => {
                const kind = event.target.value;

                if (
                  kind === "cli" ||
                  kind === "mcp-stdio" ||
                  kind === "mcp-http"
                ) {
                  change({ kind });
                  setCredentialName(kind === "mcp-http" ? "BEARER_TOKEN" : "");
                }
              }}
              onBlur={autosave}
            >
              <option value="cli">CLI tool</option>
              <option value="mcp-stdio">Local MCP</option>
              <option value="mcp-http">Remote MCP</option>
            </select>
          </div>
          {draft.kind === "mcp-http" ? (
            <div className="settings-row">
              <label htmlFor="integration-url">URL</label>
              <Input
                id="integration-url"
                type="url"
                value={draft.url ?? ""}
                onChange={(event) => change({ url: event.target.value })}
                onBlur={autosave}
                required
              />
            </div>
          ) : (
            <>
              <div className="settings-row">
                <label htmlFor="integration-command">Command</label>
                <Input
                  id="integration-command"
                  value={draft.command ?? ""}
                  onChange={(event) => change({ command: event.target.value })}
                  onBlur={autosave}
                  required
                />
              </div>
              <div className="settings-row team-stack-row">
                <label htmlFor="integration-args">Arguments</label>
                <Textarea
                  id="integration-args"
                  value={args}
                  onChange={(event) => {
                    setArgs(event.target.value);
                    change({
                      args: event.target.value.split("\n").filter(Boolean),
                    });
                  }}
                  onBlur={autosave}
                />
              </div>
            </>
          )}
          {draft.kind !== "mcp-http" && (
            <div className="settings-row">
              <label htmlFor="credential-name">Credential variable</label>
              <Input
                id="credential-name"
                value={credentialName}
                onChange={(event) => setCredentialName(event.target.value)}
                onBlur={autosave}
                autoComplete="off"
              />
            </div>
          )}
          {existing && draft.kind === "mcp-http" && (
            <div className="settings-row">
              <span>Authentication</span>
              <Button
                variant="outline"
                disabled={pending || disabled}
                onClick={(event) => {
                  if (pending || disabled) event.preventDefault();
                }}
                render={
                  <a
                    href={`/api/teams/${encodeURIComponent(teamId)}/integrations/${encodeURIComponent(initial.id)}/authorize`}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                Sign in
              </Button>
            </div>
          )}
          <div className="settings-row">
            <label htmlFor="credential-value">
              {draft.kind === "mcp-http" ? "Bearer token" : "Credential"}
            </label>
            <Input
              id="credential-value"
              type="password"
              value={credential}
              onChange={(event) => {
                credentialRef.current = event.target.value;
                setCredential(event.target.value);
              }}
              onBlur={autosave}
              autoComplete="new-password"
            />
          </div>
        </fieldset>
        {error && (
          <div>
            <p role="alert">{error}</p>
            {credential && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  credentialRef.current = "";
                  setCredential("");
                  setError("");
                }}
              >
                Discard credential
              </Button>
            )}
          </div>
        )}
        {!configured && (
          <div className="actions">
            <Button
              variant="outline"
              type="button"
              disabled={pending}
              onClick={onBack}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || disabled}>
              {pending ? "Adding…" : "Add integration"}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
