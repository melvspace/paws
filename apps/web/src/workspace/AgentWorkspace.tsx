import { AgentAvatar } from "../AgentAvatar.tsx";
import { defaultAgentAvatar } from "@paws/contracts";
import { useComposerAttachments } from "./useComposerAttachments.ts";
import { useAtomValue } from "@effect/atom-react";
import { providersAtom } from "@paws/client-runtime";
import { modelKey, normalizeModelOptions } from "@paws/provider-core";
import { useModelPreferences } from "./modelPreferences.ts";
import { availableModels } from "./models.ts";
import { ComposerInput } from "./ComposerInput.tsx";
import { Button } from "../components/ui/button.tsx";
// Layout adapted from T3 Code ChatView.tsx and chat/ChatComposer.tsx (MIT).
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CornerUpRightIcon, ListPlusIcon, SettingsIcon } from "lucide-react";
import type { Agent, FollowUpMode } from "@paws/contracts";
import { readWorkspace, writeWorkspace } from "./state.ts";
import { PanelLayoutControls } from "./PanelLayoutControls.tsx";
import { ChatRightPanel } from "./ChatRightPanel.tsx";
import { ChatTerminalDrawer } from "./ChatTerminalDrawer.tsx";
import { ContextWindowMeter } from "./ContextWindowMeter.tsx";
import { ReasoningPicker } from "./ReasoningPicker.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import "./workspace.css";
import { ChatHistory } from "./ChatHistory.tsx";
import { useConversation } from "./useConversation.ts";
import { useChatPreferences } from "../settings/chatPreferences.ts";

interface AgentWorkspaceProps {
  agent: Agent;
  onSettings: () => void;
  onProviderSettings: () => void;
  navigation?: ReactNode;
}

export function AgentWorkspace({
  agent,
  onSettings,
  onProviderSettings,
  navigation,
}: AgentWorkspaceProps) {
  const chat = useConversation(agent.id);
  const { followUpMode } = useChatPreferences();
  const [alternateHeld, setAlternateHeld] = useState(false);
  const alternateMode = followUpMode === "steer" ? "queue" : "steer";
  const mode = alternateHeld ? alternateMode : followUpMode;

  useEffect(() => {
    const updateModifier = (event: KeyboardEvent) =>
      setAlternateHeld(event.ctrlKey || event.metaKey);
    const resetModifier = () => setAlternateHeld(false);
    window.addEventListener("keydown", updateModifier);
    window.addEventListener("keyup", updateModifier);
    window.addEventListener("blur", resetModifier);

    return () => {
      window.removeEventListener("keydown", updateModifier);
      window.removeEventListener("keyup", updateModifier);
      window.removeEventListener("blur", resetModifier);
    };
  }, []);

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
  const files = useComposerAttachments(
    agent.id,
    state.attachments,
    (attachment) =>
      setState((current) => ({
        ...current,
        attachments: [
          ...current.attachments.filter((file) => file.id !== attachment.id),
          attachment,
        ],
      })),
  );
  const { providers } = useAtomValue(providersAtom);
  const models = availableModels(providers);
  const { hidden } = useModelPreferences();
  const previousSelection = chat.conversation?.selection;
  const selectedModelId =
    state.model ||
    (previousSelection
      ? modelKey(previousSelection.providerId, previousSelection.modelId)
      : "");
  const selectedModel = selectedModelId
    ? models.find((model) => model.id === selectedModelId)
    : models.find((model) => !hidden.includes(model.id));
  const selectedOptions = normalizeModelOptions(
    selectedModel,
    !state.model && previousSelection
      ? previousSelection.options
      : state.options,
  );
  const running = chat.conversation?.status === "running";
  const canSend = !!selectedModel && !chat.busy && !files.uploading;
  const hasDraft = !!state.draft.trim() || !!state.attachments.length;
  const showStop = running && !hasDraft;
  const sendLabel = running
    ? mode === "steer"
      ? "Steer message"
      : "Queue message"
    : "Send message";

  async function send(sendMode: FollowUpMode = followUpMode) {
    if (!canSend || !selectedModel || !hasDraft) return;

    const draft = state.draft;
    const attachments = state.attachments;
    const attachmentIds = state.attachments.map((file) => file.id);
    // Pin even the automatically selected model, so catalog ordering cannot change it later.
    setState((current) => ({
      ...current,
      model: selectedModel.id,
      options: selectedOptions,
      draft: "",
      attachments: [],
    }));
    await chat.send(
      {
        text: draft,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        mode: sendMode,
        selection: {
          providerId: selectedModel.provider,
          modelId: selectedModel.nativeId,
          options: selectedOptions,
        },
      },
      attachments,
    );
  }

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

  // Persist each agent's model, options, draft and panel visibility.
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
          {navigation}
          <div className="workspace-title">
            <AgentAvatar
              avatar={agent.avatar ?? defaultAgentAvatar(agent.id)}
            />
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
          <ChatHistory
            conversation={chat.conversation}
            outgoing={chat.outgoing}
            onRetryMessage={chat.retryMessage}
            providers={providers}
            selectedModel={
              selectedModel
                ? {
                    providerId: selectedModel.provider,
                    modelId: selectedModel.nativeId,
                    name: selectedModel.name,
                    driver: selectedModel.driver,
                  }
                : undefined
            }
            busy={chat.busy}
            error={chat.error}
            onQueueUpdate={chat.updateQueue}
            onContinue={chat.continueInterrupted}
            onRestoreDraft={(text) => {
              setState((current) => ({
                ...current,
                draft: current.draft ? `${current.draft}\n${text}` : text,
              }));
              rootRef.current
                ?.querySelector<HTMLElement>('.chat-composer [role="textbox"]')
                ?.focus();
            }}
            onReply={(reply) => {
              const selection = chat.conversation?.selection;

              return selection
                ? chat.send({ text: "", reply, selection })
                : Promise.resolve(false);
            }}
          />
          <div className="chat-composer-lane">
            <div className="chat-composer">
              <ComposerInput
                agentId={agent.id}
                commands={[
                  {
                    name: "model",
                    description: "Choose a model",
                    run: () =>
                      rootRef.current
                        ?.querySelector<HTMLButtonElement>(
                          ".model-picker-trigger",
                        )
                        ?.click(),
                  },
                  ...(!chat.busy &&
                  !running &&
                  chat.conversation?.selection &&
                  ["codex", "claudeAgent", "opencode"].includes(
                    providers.find(
                      (item) =>
                        item.config.id ===
                        chat.conversation?.selection?.providerId,
                    )?.config.driver ?? "",
                  )
                    ? [
                        {
                          name: "compact",
                          description: "Compact conversation context",
                          run: () => void chat.compact(),
                        },
                      ]
                    : []),
                  ...(!chat.busy && running
                    ? [
                        {
                          name: "stop",
                          description: "Stop the current reply",
                          run: () => void chat.stop(),
                        },
                      ]
                    : []),
                ]}
                attachments={state.attachments}
                uploading={files.uploading}
                attachmentError={files.error}
                onAttach={(items) => void files.add(items)}
                onRemoveAttachment={(id) =>
                  setState((current) => ({
                    ...current,
                    attachments: current.attachments.filter(
                      (file) => file.id !== id,
                    ),
                  }))
                }
                label={`Message ${agent.name}`}
                value={state.draft}
                onChange={(draft) =>
                  setState((current) => ({ ...current, draft }))
                }
                onSend={(alternate) =>
                  void send(alternate ? alternateMode : followUpMode)
                }
              >
                <div className="composer-actions">
                  <div className="composer-model-controls">
                    <ModelPicker
                      value={selectedModel?.id ?? selectedModelId}
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
                      value={selectedOptions}
                      onChange={(options) =>
                        setState((current) => ({
                          ...current,
                          model: selectedModel?.id ?? current.model,
                          options,
                        }))
                      }
                    />
                  </div>
                  <ContextWindowMeter
                    usage={chat.conversation?.contextUsage}
                    modelName={
                      models.find(
                        (model) =>
                          model.nativeId ===
                            chat.conversation?.selection?.modelId &&
                          model.provider ===
                            chat.conversation?.selection?.providerId,
                      )?.name
                    }
                    onCompact={() => void chat.compact()}
                    disabled={
                      chat.busy || running || !chat.conversation?.selection
                    }
                    compacting={
                      running && chat.conversation?.activity === "compact"
                    }
                  />
                  <Button
                    className="composer-send-button"
                    data-action={showStop ? "stop" : "send"}
                    type="button"
                    disabled={showStop ? chat.busy : !canSend || !hasDraft}
                    onClick={(event) =>
                      void (showStop
                        ? chat.stop()
                        : send(
                            event.ctrlKey || event.metaKey
                              ? alternateMode
                              : followUpMode,
                          ))
                    }
                    aria-label={showStop ? "Stop reply" : sendLabel}
                    title={
                      showStop
                        ? "Stop reply"
                        : !selectedModel
                          ? "Choose a model to chat"
                          : running
                            ? `Click to ${followUpMode}, Ctrl/Cmd-click or Ctrl/Cmd+Enter to ${alternateMode}`
                            : sendLabel
                    }
                  >
                    {showStop ? (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        aria-hidden
                      >
                        <rect
                          x="2"
                          y="2"
                          width="8"
                          height="8"
                          rx="1.5"
                          fill="currentColor"
                        />
                      </svg>
                    ) : running ? (
                      mode === "queue" ? (
                        <ListPlusIcon size={16} aria-hidden />
                      ) : (
                        <CornerUpRightIcon size={16} aria-hidden />
                      )
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        aria-hidden
                      >
                        <path
                          d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </Button>
                </div>
              </ComposerInput>
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
