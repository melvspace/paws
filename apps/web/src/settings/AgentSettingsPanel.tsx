import { MemoriesSettings } from "./MemoriesSettings.tsx";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Agent } from "@paws/contracts";
import { AgentDialog } from "../AgentDialog.tsx";
import { RoutinesSettings } from "./RoutinesSettings.tsx";
import "./agent-settings.css";

export function AgentSettingsPanel({
  agent,
  connected,
  beforeClose,
  onDismiss,
  initialPage = "general",
}: {
  agent: Agent;
  connected: boolean;
  beforeClose: MutableRefObject<(() => Promise<void>) | null>;
  onDismiss: () => void;
  initialPage?: "general" | "routines" | "memories";
}) {
  const [page, setPage] = useState(initialPage);
  const scroll = useRef<HTMLDivElement>(null);
  const generalFlush = useRef<(() => Promise<void>) | null>(null);
  const memoryFlush = useRef<(() => Promise<void>) | null>(null);
  const routineFlush = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const flush = async () => {
      await (
        page === "general"
          ? generalFlush
          : page === "memories"
            ? memoryFlush
            : routineFlush
      ).current?.();
    };
    beforeClose.current = flush;

    return () => {
      if (beforeClose.current === flush) beforeClose.current = null;
    };
  }, [beforeClose, page]);

  async function navigate(next: typeof page) {
    try {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();

      await beforeClose.current?.();
      setPage(next);
      scroll.current?.scrollTo(0, 0);
    } catch {
      // Keep the active editor and its failed edits visible.
    }
  }

  return (
    <div className="agent-settings-scroll" ref={scroll}>
      <div hidden={page !== "general"}>
        <AgentDialog
          agent={agent}
          connected={connected}
          embedded
          beforeClose={generalFlush}
          onDismiss={onDismiss}
          onMemories={() => void navigate("memories")}
          onRoutines={() => void navigate("routines")}
        />
      </div>
      {page === "memories" && (
        <MemoriesSettings
          kind="agents"
          ownerId={agent.id}
          connected={connected}
          beforeClose={memoryFlush}
          onBack={() => void navigate("general")}
        />
      )}
      {page === "routines" && (
        <div className="agent-routines-page">
          <RoutinesSettings
            agentId={agent.id}
            beforeClose={routineFlush}
            onBack={() => void navigate("general")}
          />
        </div>
      )}
    </div>
  );
}
