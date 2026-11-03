import { describe, expect, it } from "vite-plus/test";
import type { Conversation, ChatMessage } from "@paws/contracts";
import { chatHistoryPage } from "./chatHistoryPaging.ts";

function conversation(messages: readonly ChatMessage[]): Conversation {
  return {
    agentId: "agent",
    revision: 1,
    status: "idle",
    error: null,
    selection: null,
    messages,
  };
}

const messages = Array.from({ length: 100 }, (_, index): ChatMessage => ({
  id: String(index),
  role: index % 2 ? "assistant" : "user",
  text: String(index),
  createdAt: new Date(index * 1000).toISOString(),
}));

describe("chat history pages", () => {
  it("pages complete turns without gaps, including after appends", () => {
    const full = conversation(messages);
    const recent = chatHistoryPage(full);
    expect(recent.messages).toEqual(messages.slice(80));
    expect(full.messages).toHaveLength(100);
    const appended = conversation([
      ...messages,
      { ...messages[0]!, id: "new" },
    ]);
    const older = chatHistoryPage(appended, recent.historyCursor!);
    expect(older.messages).toEqual(messages.slice(40, 80));
    const oldest = chatHistoryPage(appended, older.historyCursor!);
    expect(oldest.messages).toEqual(messages.slice(0, 40));
    expect(oldest.historyCursor).toBeNull();
  });

  it("bounds long replies and agent-driven histories and still advances", () => {
    const full = conversation(
      messages.map((message) => ({ ...message, role: "assistant" })),
    );
    const recent = chatHistoryPage(full);
    expect(recent.messages).toHaveLength(75);
    expect(chatHistoryPage(full, recent.historyCursor!).messages).toHaveLength(
      25,
    );
    const large = conversation(
      messages.map((message) => ({ ...message, text: "x".repeat(600_000) })),
    );
    const page = chatHistoryPage(large);
    expect(page.messages).toHaveLength(1);
    expect(chatHistoryPage(large, page.historyCursor!).messages[0]?.id).toBe(
      "98",
    );
    expect(
      chatHistoryPage(
        conversation([{ ...messages[0]!, text: "x".repeat(1_100_000) }]),
      ).messages,
    ).toHaveLength(1);
  });

  it("rejects malformed, cross-agent, and deleted-anchor cursors", () => {
    const page = chatHistoryPage(conversation(messages));
    expect(() => chatHistoryPage(conversation(messages), "invalid")).toThrow(
      "History changed",
    );
    expect(() =>
      chatHistoryPage(
        { ...conversation(messages), agentId: "other" },
        page.historyCursor!,
      ),
    ).toThrow("History changed");
    expect(() =>
      chatHistoryPage(conversation([]), page.historyCursor!),
    ).toThrow("History changed");
  });

  it("only includes handoffs belonging to the page", () => {
    const handoff = {
      id: "h",
      beforeMessageId: "0",
      from: [],
      to: { providerId: "p", modelId: "m", name: "M" },
      status: "completed" as const,
    };
    const full = { ...conversation(messages), handoffs: [handoff] };
    const recent = chatHistoryPage(full);
    expect(recent.handoffs).toEqual([]);
    const older = chatHistoryPage(full, recent.historyCursor!);
    expect(chatHistoryPage(full, older.historyCursor!).handoffs).toEqual([
      handoff,
    ]);
  });
});
