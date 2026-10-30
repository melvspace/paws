import { useAtomValue } from "@effect/atom-react";
import { providersAtom } from "@paws/client-runtime";
import { normalizeModelOptions } from "@paws/provider-core";
import { useModelPreferences } from "./modelPreferences.ts";
import { availableModels } from "./models.ts";
import { Textarea } from "../components/ui/textarea.tsx";
import { Button } from "../components/ui/button.tsx";
// Layout adapted from T3 Code ChatView.tsx and chat/ChatComposer.tsx (MIT).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpIcon, Bot, SettingsIcon } from "lucide-react";
import type { Agent } from "@paws/contracts";
import { readWorkspace, writeWorkspace } from "./state.ts";
import { PanelLayoutControls } from "./PanelLayoutControls.tsx";
import { ChatRightPanel } from "./ChatRightPanel.tsx";
import { ChatTerminalDrawer } from "./ChatTerminalDrawer.tsx";
import { ContextWindowMeter } from "./ContextWindowMeter.tsx";
import { ReasoningPicker } from "./ReasoningPicker.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import "./workspace.css";

interface AgentWorkspaceProps {
  agent: Agent;
  onSettings: () => void;
  onProviderSettings: () => void;
}

export function AgentWorkspace({
  agent,
  onSettings,
  onProviderSettings,
}: AgentWorkspaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({
    width: 1280,
    height: 800,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  const [maximized, setMaximized] = useState(false);
  const [state, setState] = useState(() =>
    readWorkspace({ getItem: (key) => localStorage.getItem(key) }, agent.id),
  );
  const { providers } = useAtomValue(providersAtom);
  const models = availableModels(providers);
  const { hidden } = useModelPreferences();
  const selectedModel = state.model
    ? models.find((model) => model.id === state.model)
    : models.find((model) => !hidden.includes(model.id));
  const sheet = bounds.width < 760;
  const rightPanelMaximized = maximized && state.sidebarOpen && !sheet;

  // Measure the workspace rather than the window so the agent rail participates in limits.
  useLayoutEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    const measure = () =>
      setBounds({
        width: root.clientWidth,
        height: root.clientHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener("resize", measure);
    measure();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Persist drafts and panel visibility independently from drag dimensions.
  useEffect(() => {
    writeWorkspace(
      { setItem: (key, value) => localStorage.setItem(key, value) },
      agent.id,
      state,
    );
  }, [agent.id, state]);

  function toggle(panel: "sidebarOpen" | "bottomOpen") {
    setState((current) => ({ ...current, [panel]: !current[panel] }));
  }

  const controls = (
    <PanelLayoutControls
      terminalOpen={state.bottomOpen}
      rightPanelOpen={state.sidebarOpen}
      maximized={rightPanelMaximized}
      showMaximize={!sheet}
      onToggleTerminal={() => {
        setMaximized(false);
        toggle("bottomOpen");
      }}
      onToggleRightPanel={() => toggle("sidebarOpen")}
      onToggleMaximized={() => setMaximized(!maximized)}
    />
  );

  return (
    <div ref={rootRef} className="agent-workspace">
      <div className="workspace-conversation" hidden={rightPanelMaximized}>
        <header className="workspace-header">
          <div className="workspace-title">
            <h1>{agent.name}</h1>
          </div>
          <Button
            type="button"
            className="sidebar-icon-button"
            title="Agent settings"
            aria-label={`Settings for ${agent.name}`}
            onClick={onSettings}
          >
            <SettingsIcon aria-hidden />
          </Button>
          {(!state.sidebarOpen || sheet) && controls}
        </header>
        <section className="chat-panel" id="workspace-chat" aria-label="Chat">
          <div className="chat-history">
            <Bot size={30} aria-hidden />
            <p>No messages</p>
          </div>
          <div className="chat-composer-lane">
            <div className="chat-composer">
              <Textarea
                aria-label={`Message ${agent.name}`}
                placeholder="Message…"
                value={state.draft}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    draft: event.target.value,
                  }))
                }
                maxLength={32000}
              />
              <div className="composer-toolbar">
                <div className="composer-actions">
                  <div className="composer-model-controls">
                    <ModelPicker
                      value={selectedModel?.id ?? state.model}
                      models={models}
                      onSettings={onProviderSettings}
                      onChange={(model) =>
                        setState((current) => ({
                          ...current,
                          model,
                          options: normalizeModelOptions(
                            models.find((item) => item.id === model),
                            {},
                          ),
                        }))
                      }
                    />
                    <ReasoningPicker
                      model={selectedModel}
                      value={state.options}
                      onChange={(options) =>
                        setState((current) => ({ ...current, options }))
                      }
                    />
                  </div>
                  <ContextWindowMeter />
                  <Button
                    className="composer-send-button"
                    type="button"
                    disabled
                    aria-label="Send message"
                    title="Agent runtime is not connected"
                  >
                    <ArrowUpIcon size={18} aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>
        <ChatTerminalDrawer
          agentId={agent.id}
          open={state.bottomOpen}
          columnHeight={bounds.height}
          viewportHeight={bounds.viewportHeight}
          onClose={() => toggle("bottomOpen")}
        />
      </div>
      <ChatRightPanel
        agentId={agent.id}
        open={state.sidebarOpen}
        sheet={sheet}
        maximized={rightPanelMaximized}
        rowWidth={bounds.width}
        viewportWidth={bounds.viewportWidth}
        controls={controls}
        onClose={() =>
          setState((current) => ({ ...current, sidebarOpen: false }))
        }
      />
    </div>
  );
}
