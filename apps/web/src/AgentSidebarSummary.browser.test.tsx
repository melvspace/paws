import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { Agent, Conversation } from "@paws/contracts";
import { render } from "../test/render.tsx";
import { AgentSidebarSummary } from "./AgentSidebarSummary.tsx";
import { useMarkConversationRead } from "./workspace/conversationReadState.ts";

const agent: Agent = {
  id: "sidebar-fixture",
  name: "Mailkeeper",
  provider: "codex",
  status: "configured",
  createdAt: "2026-11-03",
};
const conversation: Conversation = {
  agentId: agent.id,
  revision: 1,
  status: "idle",
  error: null,
  selection: null,
  messages: [
    {
      id: "user",
      role: "user",
      text: "Check mail",
      createdAt: "2026-11-03T09:00:00Z",
    },
    {
      id: "reply",
      role: "assistant",
      text: "I still haven’t finished\nchecking your mail.",
      createdAt: "2026-11-03T09:10:00Z",
    },
  ],
};
const key = `paws.conversation-read.${agent.id}`;

function Fixture({
  reading = false,
  data = conversation,
}: {
  reading?: boolean;
  data?: Conversation;
}) {
  useMarkConversationRead(reading ? data : undefined);

  return (
    <AgentSidebarSummary agent={agent} conversation={data} animated={false} />
  );
}

afterEach(() => {
  localStorage.removeItem(key);
  vi.restoreAllMocks();
});

it("shows the latest preview, timestamp, and completed reply count", async () => {
  await using _screen = await render(<Fixture />);
  await expect
    .element(page.getByText("I still haven’t finished checking your mail."))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("1 unread message"))
    .toHaveTextContent("1");
  expect(document.querySelector("time")?.dateTime).toBe(
    "2026-11-03T09:10:00.000Z",
  );
});

it("persists reads across remounts and counts only new completed replies", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);

  {
    await using _screen = await render(<Fixture reading />);
    await expect.poll(() => localStorage.getItem(key)).toBe("reply");
    await expect
      .element(page.getByLabelText("1 unread message"))
      .not.toBeInTheDocument();
  }

  const data: Conversation = {
    ...conversation,
    messages: [
      ...conversation.messages,
      {
        id: "new",
        role: "assistant",
        text: "Done",
        createdAt: "2026-11-03T09:11:00Z",
      },
      {
        id: "stream",
        role: "assistant",
        text: "Next",
        streaming: true,
        createdAt: "2026-11-03T09:12:00Z",
      },
    ],
  };
  await using _screen = await render(<Fixture data={data} />);
  await expect.element(page.getByLabelText("1 unread message")).toBeVisible();
  await expect.element(page.getByText("Next", { exact: true })).toBeVisible();
});

it("leaves background chats unread until the window gains focus", async () => {
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  await using _screen = await render(<Fixture reading />);
  await expect.element(page.getByLabelText("1 unread message")).toBeVisible();
  expect(localStorage.getItem(key)).toBeNull();
  focus.mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  await expect.poll(() => localStorage.getItem(key)).toBe("reply");
  await expect
    .element(page.getByLabelText("1 unread message"))
    .not.toBeInTheDocument();
});
