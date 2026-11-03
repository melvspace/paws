import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  PlusIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { connectBrowser } from "@paws/client-runtime";
import type {
  BrowserAction,
  BrowserClientMessage,
  BrowserState,
} from "@paws/contracts";
import { Button } from "../components/ui/button.tsx";
import "./browser.css";

function browserPoint(
  image: HTMLImageElement,
  viewport: { width: number; height: number },
  point: { clientX: number; clientY: number },
) {
  const rect = image.getBoundingClientRect();
  const width = image.naturalWidth || viewport.width;
  const height = image.naturalHeight || viewport.height;
  const scale = Math.min(rect.width / width, rect.height / height);

  if (!scale) return null;

  const left = rect.left + (rect.width - width * scale) / 2;
  const top = rect.top + (rect.height - height * scale) / 2;
  const x = (point.clientX - left) / (width * scale);
  const y = (point.clientY - top) / (height * scale);

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;

  return { x: x * viewport.width, y: y * viewport.height };
}

export function BrowserPanel({
  agentId,
  active,
  compact = false,
}: {
  agentId: string;
  active: boolean;
  compact?: boolean;
}) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [status, setStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("Connecting to browser…");
  const [attempt, setAttempt] = useState(0);
  const [address, setAddress] = useState("");
  const [frame, setFrame] = useState<{ tabId: string; data: string } | null>(
    null,
  );
  const [prompt, setPrompt] = useState("");
  const connection = useRef<ReturnType<typeof connectBrowser> | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const addressFocused = useRef(false);
  const current = useRef<BrowserState | null>(null);
  const tab = state?.tabs.find((item) => item.id === state.selectedTabId);
  const controlling = !!tab && state?.controllerTabId === tab.id;

  useEffect(() => {
    setStatus("connecting");
    setError(null);
    setProgress("Connecting to browser…");
    setState(null);
    setFrame(null);
    const client = connectBrowser(
      agentId,
      (message) => {
        if (message.type === "state") {
          current.current = message;
          setState(message);
          setStatus("connected");
        } else if (message.type === "status") setProgress(message.message);
        else if (message.type === "frame")
          setFrame({ tabId: message.tabId, data: message.data });
        else setError(message.message);
      },
      (connected) => {
        if (!connected) setStatus("disconnected");
      },
    );
    connection.current = client;

    return () => {
      connection.current = null;
      client.close();
    };
  }, [agentId, attempt]);

  useEffect(() => {
    if (!addressFocused.current)
      setAddress(tab?.url === "about:blank" ? "" : (tab?.url ?? ""));
  }, [tab?.id, tab?.url]);

  // Hidden panels stop streaming; takeover lasts until explicitly returned.
  useEffect(() => {
    if (status !== "connected" || !state) return;

    if (!active) {
      if (state.selectedTabId)
        connection.current?.send({ type: "watch", tabId: null });
    } else if (!state.selectedTabId && state.tabs[0]) {
      connection.current?.send({ type: "watch", tabId: state.tabs[0].id });
    }
  }, [active, status, state]);

  useEffect(() => {
    const releaseKeys = () => {
      const snapshot = current.current;

      if (snapshot?.controllerTabId)
        connection.current?.send({
          type: "resetInput",
          tabId: snapshot.controllerTabId,
          generation:
            snapshot.tabs.find((item) => item.id === snapshot.controllerTabId)
              ?.generation ?? 0,
        });
    };
    window.addEventListener("blur", releaseKeys);

    return () => window.removeEventListener("blur", releaseKeys);
  }, []);

  useEffect(() => {
    const node = image.current;

    if (!node || !controlling || !tab || !state) return;

    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const position = browserPoint(node, state, event);

      if (!position) return;

      const scale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? state.height : 1;
      connection.current?.send({
        type: "wheel",
        tabId: tab.id,
        generation: tab.generation,
        ...position,
        deltaX: Math.max(-4096, Math.min(4096, event.deltaX * scale)),
        deltaY: Math.max(-4096, Math.min(4096, event.deltaY * scale)),
      });
    };
    node.addEventListener("wheel", wheel, { passive: false });

    return () => node.removeEventListener("wheel", wheel);
  }, [
    controlling,
    tab?.id,
    tab?.generation,
    state?.width,
    state?.height,
    frame?.tabId,
  ]);

  useLayoutEffect(() => {
    const node = stage.current;
    const client = connection.current;

    if (
      compact ||
      !node ||
      !client ||
      !tab ||
      !active ||
      status !== "connected"
    )
      return;

    let previous = "";
    const measure = () => {
      if (!node.clientWidth || !node.clientHeight) return;

      const width = Math.max(160, Math.min(4096, node.clientWidth));
      const height = Math.max(160, Math.min(4096, node.clientHeight));
      const size = `${width}:${height}`;

      if (size === previous) return;

      previous = size;
      client.send({
        type: "resize",
        tabId: tab.id,
        generation: tab.generation,
        width,
        height,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();

    return () => observer.disconnect();
  }, [active, compact, status, tab?.id, tab?.generation]);

  function send(message: BrowserClientMessage) {
    setError(null);

    if (!connection.current?.send(message))
      setError("Browser disconnected. Reconnect to continue.");
  }

  function action(input: BrowserAction) {
    send({ type: "action", generation: tab?.generation ?? 0, input });
  }

  function point(event: { clientX: number; clientY: number }) {
    return image.current && state
      ? browserPoint(image.current, state, event)
      : null;
  }

  return (
    <section
      className="browser-panel"
      aria-label="Browser"
      data-compact={compact || undefined}
    >
      <div className="browser-chrome" hidden={compact}>
        <div className="browser-tabs" aria-label="Browser tabs">
          {state?.tabs.map((item) => (
            <div
              key={item.id}
              className="browser-tab"
              data-active={item.id === tab?.id}
            >
              <Button
                variant="ghost"
                onClick={() => send({ type: "watch", tabId: item.id })}
                aria-pressed={item.id === tab?.id}
              >
                {item.title || "New tab"}
              </Button>
              <Button
                variant="ghost"
                aria-label={`Close ${item.title || "new tab"}`}
                disabled={item.id !== state.controllerTabId}
                onClick={() =>
                  send({
                    type: "action",
                    generation: item.generation,
                    input: { action: "close", tabId: item.id },
                  })
                }
              >
                <XIcon size={12} aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            aria-label="New browser tab"
            disabled={status !== "connected"}
            onClick={() => action({ action: "open" })}
          >
            <PlusIcon size={16} aria-hidden />
          </Button>
        </div>
        <form
          className="browser-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const value = address.trim();

            if (!value) return;

            const url = /^[a-z][a-z\d+.-]*:/i.test(value)
              ? value
              : `https://${value}`;
            action(
              tab
                ? { action: "navigate", tabId: tab.id, url }
                : { action: "open", url },
            );
          }}
        >
          <Button
            type="button"
            variant="ghost"
            aria-label="Browser back"
            disabled={!controlling}
            onClick={() => action({ action: "back", tabId: tab?.id })}
          >
            <ArrowLeftIcon size={14} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="Browser forward"
            disabled={!controlling}
            onClick={() => action({ action: "forward", tabId: tab?.id })}
          >
            <ArrowRightIcon size={14} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="Reload browser"
            disabled={!controlling}
            onClick={() => action({ action: "reload", tabId: tab?.id })}
          >
            <RotateCwIcon size={14} aria-hidden />
          </Button>
          <input
            aria-label="Browser address"
            value={address}
            disabled={status !== "connected" || (!!tab && !controlling)}
            onFocus={() => {
              addressFocused.current = true;
            }}
            onBlur={() => {
              addressFocused.current = false;
            }}
            onChange={(event) => setAddress(event.target.value)}
          />
          {tab && (
            <Button
              type="button"
              variant="outline"
              disabled={status !== "connected"}
              onClick={() =>
                send({
                  type: controlling ? "releaseControl" : "takeControl",
                  tabId: tab.id,
                })
              }
            >
              {controlling ? "Return control" : "Take control"}
            </Button>
          )}
        </form>
      </div>
      {compact && tab && status === "connected" && (
        <Button
          className="browser-floating-control"
          variant="outline"
          onClick={() =>
            send({
              type: controlling ? "releaseControl" : "takeControl",
              tabId: tab.id,
            })
          }
        >
          {controlling ? "Return control" : "Take control"}
        </Button>
      )}
      {error && (
        <div className="browser-notice" role="alert">
          {error}
        </div>
      )}
      {status === "connecting" && (
        <div className="browser-notice" role="status">
          {progress}
        </div>
      )}
      {status === "disconnected" && (
        <div className="browser-notice" role="status">
          Browser disconnected.{" "}
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Reconnect
          </Button>
        </div>
      )}
      {!compact && status === "connected" && tab && (
        <div className="browser-control-status" role="status">
          {tab.loading
            ? "Loading…"
            : controlling
              ? "You have control"
              : tab.owner === "human"
                ? "Another viewer has control"
                : "Agent has control"}
        </div>
      )}
      {tab?.dialog && (
        <form
          className="browser-notice"
          onSubmit={(event) => {
            event.preventDefault();
            action({
              action: "dialog",
              tabId: tab.id,
              accept: true,
              text: prompt,
            });
            setPrompt("");
          }}
        >
          <p>{tab.dialog.message}</p>
          {tab.dialog.type === "prompt" && (
            <input
              aria-label="Page dialog response"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={!controlling}
            />
          )}
          <Button type="submit" disabled={!controlling}>
            OK
          </Button>
          <Button
            type="button"
            disabled={!controlling}
            onClick={() =>
              action({ action: "dialog", tabId: tab.id, accept: false })
            }
          >
            Dismiss
          </Button>
        </form>
      )}
      {!tab && status === "connected" && (
        <div className="browser-empty">
          Open a tab or ask your agent to browse.
        </div>
      )}
      {tab && (
        <div ref={stage} className="browser-stage">
          {frame?.tabId === tab.id ? (
            <img
              ref={image}
              src={`data:image/jpeg;base64,${frame.data}`}
              alt="Live browser page"
              draggable={false}
              tabIndex={controlling ? 0 : -1}
              aria-label="Browser page interaction"
              data-controlling={controlling}
              onContextMenu={(event) => event.preventDefault()}
              onBlur={() => {
                if (controlling)
                  send({
                    type: "resetInput",
                    tabId: tab.id,
                    generation: tab.generation,
                  });
              }}
              onPointerCancel={() => {
                if (controlling)
                  send({
                    type: "resetInput",
                    tabId: tab.id,
                    generation: tab.generation,
                  });
              }}
              onPointerDown={(event) => {
                if (!controlling) return;

                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                const position = point(event);

                if (position)
                  send({
                    type: "pointer",
                    tabId: tab.id,
                    generation: tab.generation,
                    ...position,
                    phase: "down",
                    button:
                      event.button === 2
                        ? "right"
                        : event.button === 1
                          ? "middle"
                          : "left",
                  });
              }}
              onPointerUp={(event) => {
                if (!controlling) return;

                event.preventDefault();
                const position = point(event);

                if (position)
                  send({
                    type: "pointer",
                    tabId: tab.id,
                    generation: tab.generation,
                    ...position,
                    phase: "up",
                    button:
                      event.button === 2
                        ? "right"
                        : event.button === 1
                          ? "middle"
                          : "left",
                  });
                else
                  send({
                    type: "resetInput",
                    tabId: tab.id,
                    generation: tab.generation,
                  });
              }}
              onPointerMove={(event) => {
                if (!controlling) return;

                const position = point(event);

                if (position)
                  send({
                    type: "pointer",
                    tabId: tab.id,
                    generation: tab.generation,
                    ...position,
                    phase: "move",
                    button: "left",
                  });
              }}
              onKeyDown={(event) => {
                if (!controlling) return;

                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key.toLowerCase() === "v"
                )
                  return;

                event.preventDefault();
                send({
                  type: "key",
                  tabId: tab.id,
                  generation: tab.generation,
                  key: event.key === " " ? "Space" : event.key,
                  phase: "down",
                });
              }}
              onKeyUp={(event) => {
                if (!controlling) return;

                event.preventDefault();
                send({
                  type: "key",
                  tabId: tab.id,
                  generation: tab.generation,
                  key: event.key === " " ? "Space" : event.key,
                  phase: "up",
                });
              }}
              onPaste={(event) => {
                if (!controlling) return;

                event.preventDefault();
                send({
                  type: "text",
                  tabId: tab.id,
                  generation: tab.generation,
                  text: event.clipboardData
                    .getData("text/plain")
                    .slice(0, 16000),
                });
              }}
            />
          ) : (
            <div className="browser-empty">Waiting for browser view…</div>
          )}
        </div>
      )}
    </section>
  );
}
