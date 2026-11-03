import { expect, it } from "vite-plus/test";
import type { Conversation } from "@paws/contracts";
import { mergeConversation, prependChatHistory } from "./chat.ts";

function window(
  ids: string[],
  cursor: string | null,
  revision = 1,
): Conversation {
  return {
    agentId: "a",
    revision,
    status: "idle",
    error: null,
    selection: null,
    historyCursor: cursor,
    messages: ids.map((id) => ({
      id,
      role: "assistant",
      text: id,
      createdAt: "2026-01-01",
    })),
  };
}

it("preserves fetched history while replacing the live window authoritatively", () => {
  const current = window(["1", "2", "3", "partial"], "older");
  const next = window(["3", "4"], "recent", 2);
  const merged = mergeConversation(current, next);
  expect(merged.messages.map((message) => message.id)).toEqual([
    "1",
    "2",
    "3",
    "4",
  ]);
  expect(merged.historyCursor).toBe("older");
  expect(mergeConversation(merged, current)).toBe(merged);
});

it("merges a historical response racing with a newer live revision without reverting it", () => {
  const live = window(["3", "4", "5"], "before3", 3);
  const page = window(["1", "2", "3"], null, 1);
  const merged = prependChatHistory(live, page, "before3");
  expect(merged.messages.map((message) => message.id)).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
  expect(merged.revision).toBe(3);
  expect(merged.historyCursor).toBeNull();
  expect(prependChatHistory(live, page, "stale")).toBe(live);
});

it("resets on a nonoverlapping snapshot so a reconnect cannot silently skip history", () => {
  const next = window(["10", "11"], "before10", 4);
  expect(mergeConversation(window(["1", "2"], null), next)).toBe(next);
});
