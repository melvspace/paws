import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { memoryRequest } from "@paws/client-runtime";
import type { MemoryEntry } from "@paws/contracts";
import { Button } from "../components/ui/button.tsx";
import "./memories.css";

export function MemoriesSettings({
  kind,
  ownerId,
  connected,
  beforeClose,
  onBack,
}: {
  kind: "agents" | "teams";
  ownerId: string;
  connected: boolean;
  beforeClose?: RefObject<(() => Promise<void>) | null> | undefined;
  onBack?: () => void;
}) {
  const [entries, setEntries] = useState<readonly MemoryEntry[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void memoryRequest(kind, ownerId, undefined, controller.signal)
      .then(setEntries)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Could not load memories.",
          );
      });

    return () => controller.abort();
  }, [kind, ownerId]);

  useEffect(() => {
    if (!beforeClose) return;

    const flush = async () => {
      await inFlight.current;
    };
    beforeClose.current = flush;

    return () => {
      if (beforeClose.current === flush) beforeClose.current = null;
    };
  }, [beforeClose]);

  function remove(entry: MemoryEntry) {
    if (inFlight.current) return;

    setPending(true);
    setError("");
    const request = memoryRequest(kind, ownerId, {
      action: "delete",
      id: entry.id,
      expected: entry.text,
    })
      .then((result) => {
        setEntries(result);
        setDeleting(null);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : "Could not delete memory.",
        );

        throw cause;
      })
      .finally(() => {
        inFlight.current = null;
        setPending(false);
      });
    inFlight.current = request;
    void request.catch(() => {});
  }

  return (
    <section
      className="memories-settings"
      aria-label="Memories"
      aria-busy={pending || (entries === null && !error)}
    >
      {onBack && (
        <div className="memories-toolbar">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to agent settings"
            onClick={() =>
              void Promise.resolve(inFlight.current)
                .then(onBack)
                .catch(() => {})
            }
          >
            <ArrowLeftIcon size={16} />
          </Button>
          <h3>Memories</h3>
        </div>
      )}
      {!connected && <p role="status">Disconnected</p>}
      {error && (
        <div className="memory-error">
          <p role="alert">{error}</p>
          <Button
            variant="outline"
            disabled={pending || !connected}
            onClick={() => {
              void memoryRequest(kind, ownerId)
                .then((result) => {
                  setEntries(result);
                  setDeleting(null);
                  setError("");
                })
                .catch((cause: unknown) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not reload memories.",
                  ),
                );
            }}
          >
            Reload memories
          </Button>
        </div>
      )}
      {pending && <p role="status">Deleting…</p>}
      {entries === null && !error && <p role="status">Loading memories…</p>}
      {entries?.length === 0 && <p className="team-empty">No memories yet</p>}
      {!!entries?.length && (
        <div className="settings-group memory-entries">
          {entries.map((entry) => (
            <div className="memory-entry" key={entry.id}>
              <div className="memory-copy">
                <p className="memory-text">{entry.text}</p>
                <p className="memory-meta">
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                  {" · "}
                  {entry.inclusion === "essential"
                    ? "Essential"
                    : "Search when needed"}
                </p>
              </div>
              {deleting === entry.id ? (
                <div className="actions">
                  <span>Delete memory?</span>
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setDeleting(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={pending || !connected}
                    onClick={() => remove(entry)}
                  >
                    Confirm delete memory
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete memory: ${entry.text}`}
                  disabled={pending || !connected}
                  onClick={() => setDeleting(entry.id)}
                >
                  <Trash2Icon size={16} />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
