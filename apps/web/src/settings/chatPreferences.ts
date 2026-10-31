import { useSyncExternalStore } from "react";
import type { FollowUpMode } from "@paws/contracts";

export const followUpStorageKey = "paws.follow-up-mode";
export const messageDisplayStorageKey = "paws.message-display";
export type MessageDisplay = "whole" | "streaming";
const changeEvent = "paws-chat-preferences";

function read(): FollowUpMode {
  try {
    return localStorage.getItem(followUpStorageKey) === "queue"
      ? "queue"
      : "steer";
  } catch {
    return "steer";
  }
}

function readMessageDisplay(): MessageDisplay {
  try {
    return localStorage.getItem(messageDisplayStorageKey) === "streaming"
      ? "streaming"
      : "whole";
  } catch {
    return "whole";
  }
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(changeEvent, listener);

  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(changeEvent, listener);
  };
}

export function useChatPreferences() {
  const followUpMode = useSyncExternalStore(
    subscribe,
    read,
    () => "steer" as const,
  );

  const messageDisplay = useSyncExternalStore(
    subscribe,
    readMessageDisplay,
    () => "whole" as const,
  );

  return {
    messageDisplay,
    setMessageDisplay(mode: MessageDisplay) {
      try {
        localStorage.setItem(messageDisplayStorageKey, mode);
      } catch {
        // Preferences can be unavailable in restricted browser contexts.
      }
      window.dispatchEvent(new Event(changeEvent));
    },
    followUpMode,
    setFollowUpMode(mode: FollowUpMode) {
      try {
        localStorage.setItem(followUpStorageKey, mode);
      } catch {
        // Preferences can be unavailable in restricted browser contexts.
      }
      window.dispatchEvent(new Event(changeEvent));
    },
  };
}
