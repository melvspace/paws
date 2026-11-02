import { useState } from "react";
import { moveAgentTeam } from "@paws/client-runtime";
import type { Agent, Team } from "@paws/contracts";
import { Button } from "./components/ui/button.tsx";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "./components/ui/alert-dialog.tsx";

export function ReassignAgentDialog({
  agent,
  destination,
  connected,
  onClose,
  onMoved,
}: {
  agent: Agent;
  destination: Team | null;
  connected: boolean;
  onClose(): void;
  onMoved(): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function move() {
    setPending(true);
    setError("");

    try {
      await moveAgentTeam(
        agent.id,
        agent.teamId ?? null,
        destination?.id ?? null,
      );
      onMoved();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not move agent.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Move {agent.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {destination
              ? `Move to ${destination.name} and share its environment and access.`
              : agent.sandbox
                ? "Move to a private sandbox."
                : "Move to the host without a sandbox. The agent can access files and programs allowed by your account."}{" "}
            Personal files move with the agent. Shared team files stay behind.
          </AlertDialogDescription>
          {error && <p role="alert">{error}</p>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending || !connected} onClick={() => void move()}>
            {pending ? "Moving…" : "Move agent"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
