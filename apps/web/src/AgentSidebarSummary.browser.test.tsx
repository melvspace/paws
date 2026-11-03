import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { useAtomValue } from "@effect/atom-react";
import { conversationsAtom } from "@paws/client-runtime";
import type { Agent, Conversation } from "@paws/contracts";
import { render } from "../test/render.tsx";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
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
  unreadCount: 1,
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
const readConversation: Conversation = {
  ...conversation,
  revision: 2,
  lastReadMessageId: "reply",
  unreadCount: 0,
};

function Fixture({ reading = false }: { reading?: boolean }) {
  const data = useAtomValue(conversationsAtom)[0];
  const read = useMarkConversationRead(reading ? data : undefined);

  return (
    <>
      <AgentSidebarSummary agent={agent} conversation={data} animated={false} />
      {read.error && <button onClick={read.retry}>{read.error} Retry</button>}
    </>
  );
}

afterEach(() => {
  appAtomRegistry.set(conversationsAtom, []);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows the preview, timestamp, and authoritative unread count", async () => {
  appAtomRegistry.set(conversationsAtom, [{ ...conversation, unreadCount: 7 }]);
  await using _screen = await render(<Fixture />);
  await expect
    .element(page.getByText("I still haven’t finished checking your mail."))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("7 unread messages"))
    .toHaveTextContent("7");
  expect(document.querySelector("time")?.dateTime).toBe(
    "2026-11-03T09:10:00.000Z",
  );
});

it("acknowledges visible messages and uses the server response", async () => {
  appAtomRegistry.set(conversationsAtom, [conversation]);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const fetchMock = vi.fn().mockResolvedValue(Response.json(readConversation));
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(<Fixture reading />);
  await expect
    .poll(() => appAtomRegistry.get(conversationsAtom)[0]?.unreadCount)
    .toBe(0);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    `/api/agents/${agent.id}/chat/read`,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ messageId: "reply" }),
    }),
  );
  await expect
    .element(page.getByLabelText("1 unread message"))
    .not.toBeInTheDocument();
});

it("leaves background chats unread until focus and retains newer snapshots over stale responses", async () => {
  appAtomRegistry.set(conversationsAtom, [conversation]);
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const fetchMock = vi
    .fn()
    .mockResolvedValue(Response.json({ ...readConversation, revision: 0 }));
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(<Fixture reading />);
  await expect.element(page.getByLabelText("1 unread message")).toBeVisible();
  expect(fetchMock).not.toHaveBeenCalled();
  focus.mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  expect(appAtomRegistry.get(conversationsAtom)[0]?.unreadCount).toBe(1);
});

it("keeps failed reads unread and allows retry", async () => {
  appAtomRegistry.set(conversationsAtom, [conversation]);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(Response.json(readConversation));
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(<Fixture reading />);
  await expect.element(page.getByLabelText("1 unread message")).toBeVisible();
  await page
    .getByRole("button", { name: "Could not mark messages as read. Retry" })
    .click();
  await expect
    .poll(() => appAtomRegistry.get(conversationsAtom)[0]?.unreadCount)
    .toBe(0);
});
