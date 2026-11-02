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
  initialRunId,
  initialPage = "general",
}: {
  agent: Agent;
  connected: boolean;
  beforeClose: MutableRefObject<(() => Promise<void>) | null>;
  onDismiss: () => void;
  initialRunId?: string | undefined;
  initialPage?: "general" | "routines";
}) {
  const [page, setPage] = useState(initialRunId ? "routines" : initialPage);
  const scroll = useRef<HTMLDivElement>(null);
  const generalFlush = useRef<(() => Promise<void>) | null>(null);
  const routineFlush = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const flush = async () => {
      await (page === "general" ? generalFlush : routineFlush).current?.();
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
          onRoutines={() => void navigate("routines")}
        />
      </div>
      {page === "routines" && (
        <div className="agent-routines-page">
          <RoutinesSettings
            agentId={agent.id}
            beforeClose={routineFlush}
            initialRunId={initialRunId}
            onBack={() => void navigate("general")}
          />
        </div>
      )}
    </div>
  );
}
