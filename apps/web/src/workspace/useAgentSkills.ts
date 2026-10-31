import { useEffect, useState } from "react";
import { loadAgentSkills } from "@paws/client-runtime";
import type { AgentSkill } from "@paws/contracts";

export function useAgentSkills(agentId: string) {
  const [state, setState] = useState<{
    agentId: string;
    skills: readonly AgentSkill[];
    loading: boolean;
    error: string | null;
  }>({ agentId, skills: [], loading: true, error: null });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ agentId, skills: [], loading: true, error: null });
    void loadAgentSkills(agentId, controller.signal).then(
      (skills) => {
        if (!controller.signal.aborted)
          setState({ agentId, skills, loading: false, error: null });
      },
      () => {
        if (!controller.signal.aborted)
          setState({
            agentId,
            skills: [],
            loading: false,
            error: "Could not load skills.",
          });
      },
    );
    const refresh = () => setRevision((current) => current + 1);
    window.addEventListener("focus", refresh);

    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [agentId, revision]);

  return {
    ...(state.agentId === agentId
      ? state
      : { skills: [], loading: true, error: null }),
    refresh: () => setRevision((current) => current + 1),
  };
}
