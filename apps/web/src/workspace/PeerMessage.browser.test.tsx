import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import type { ChatMessage } from "@paws/contracts";
import { agentsAtom } from "@paws/client-runtime";
import { appAtomRegistry } from "../lib/atomRegistry.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { WaitingForReplies } from "./WaitingForReplies.tsx";

const request: ChatMessage = {
  id: "request",
  role: "assistant",
  text: "Please send a fresh joke.",
  createdAt: "2026-11-03T12:00:00Z",
  peer: {
    eventId: "event",
    fromAgentId: "ada",
    fromName: "Ada",
    toAgentId: "joker",
    toName: "Joker",
    kind: "message",
    direction: "sent",
    delivery: "delivered",
    expectsReply: true,
  },
};
const reply: ChatMessage = {
  id: "reply",
  role: "user",
  text: "Now I am dealing with emotional baggage.",
  createdAt: "2026-11-03T12:01:00Z",
  delivery: "delivered",
  peer: {
    eventId: "reply-event",
    fromAgentId: "joker",
    fromName: "Joker",
    toAgentId: "ada",
    toName: "Ada",
    kind: "reply",
    direction: "received",
    delivery: "queued",
    expectsReply: false,
    replyToMessageId: "event",
    requestText: request.text,
    requestAuthor: "Ada",
  },
};

function History({
  messages,
  agentId = "ada",
}: {
  messages: readonly ChatMessage[];
  agentId?: string;
}) {
  return (
    <ChatHistory
      busy={false}
      error={null}
      onReply={async () => false}
      conversation={{
        agentId,
        revision: 1,
        status: "idle",
        error: null,
        selection: null,
        messages,
      }}
    />
  );
}

afterEach(() => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents: [] },
    connected: false,
    error: null,
  });
});

it("renders a centered message row without a bubble, and reveals the author and content on expansion", async () => {
  await using _screen = await render(<History messages={[request]} />);
  const summary = page.getByText("Messaged", { exact: true });
  await expect.element(summary).toBeVisible();
  await expect
    .element(page.getByText("Please send a fresh joke."))
    .not.toBeVisible();
  const article = page.getByRole("article", { name: "Ada to Joker" }).element();
  expect(article.querySelector(".chat-message-bubble")).toBeNull();
  expect(
    getComputedStyle(article.querySelector("summary")!).justifyContent,
  ).toBe("center");
  expect(article.querySelector('svg[data-animated="false"]')).not.toBeNull();
  await summary.click();
  await expect
    .element(page.getByText("Please send a fresh joke."))
    .toBeVisible();
  await expect.element(page.getByText("Ada", { exact: true })).toBeVisible();
  await summary.click();
  await expect
    .element(page.getByText("Please send a fresh joke."))
    .not.toBeVisible();
});

it("groups consecutive peer messages, shows both directions, and quotes the original request in the update", async () => {
  await using _screen = await render(
    <History messages={[request, reply]} agentId="joker" />,
  );
  await expect.element(page.getByText("2 messages with")).toBeVisible();
  await expect.element(page.getByText(reply.text)).not.toBeVisible();
  await page.getByText("2 messages with").click();
  await expect
    .element(page.getByText("Message from", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("Informed", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByText(reply.text)).toBeVisible();
  const quote = document.querySelector(".chat-peer-quote");
  expect(quote?.textContent).toContain("Ada");
  expect(quote?.textContent).toContain(request.text);
});

it("keeps normal replies between exchanges and presents incoming results as an update", async () => {
  await using _screen = await render(
    <History
      messages={[
        request,
        {
          id: "progress",
          role: "assistant",
          text: "I asked Joker and am waiting for their reply.",
          createdAt: "2026-11-03T12:00:30Z",
        },
        reply,
      ]}
    />,
  );
  await expect
    .element(page.getByText("2 messages with"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("Messaged", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("Update from", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("I asked Joker and am waiting for their reply."))
    .toBeVisible();
});

it("shows reply counts and live recipient states above the composer, handles disconnects, and clears after completion", async () => {
  const waits = [
    {
      agentId: "ada",
      requestId: "a",
      toAgentId: "joker",
      toName: "Joker",
      batchId: "batch",
      status: "working" as const,
    },
    {
      agentId: "ada",
      requestId: "b",
      toAgentId: "grace",
      toName: "Grace",
      batchId: "batch",
      status: "done" as const,
    },
  ];
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents: [], peerWaits: waits },
    connected: true,
    error: null,
  });
  await using _screen = await render(<WaitingForReplies agentId="ada" />);
  await expect.element(page.getByText("Waiting for replies")).toBeVisible();
  await expect
    .element(page.getByLabelText("1 of 2 replies received"))
    .toBeVisible();
  await expect
    .element(page.getByText("Working", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Joker" }))
    .toHaveAttribute("href", "#agent-joker");
  appAtomRegistry.update(agentsAtom, (current) => ({
    ...current,
    connected: false,
  }));
  await expect
    .element(page.getByText("Working", { exact: true }))
    .not.toBeInTheDocument();
  expect(
    page.getByText("Disconnected", { exact: true }).elements(),
  ).toHaveLength(2);
  appAtomRegistry.set(agentsAtom, {
    snapshot: {
      agents: [],
      peerWaits: waits.map((wait) => ({ ...wait, status: "done" as const })),
    },
    connected: true,
    error: null,
  });
  await expect
    .element(page.getByText("Waiting for replies"))
    .not.toBeInTheDocument();
});

it("links peer names to their chats without toggling the message details", async () => {
  const previousHash = window.location.hash;
  await using _screen = await render(<History messages={[request]} />);

  try {
    const recipient = page.getByRole("link", { name: "Joker", exact: true });
    await expect.element(recipient).toHaveAttribute("href", "#agent-joker");
    await recipient.click();
    expect(window.location.hash).toBe("#agent-joker");
    expect(
      document.querySelector(".chat-peer-event details")?.hasAttribute("open"),
    ).toBe(false);
    await page.getByText("Messaged", { exact: true }).click();
    const author = page.getByRole("link", { name: "Ada", exact: true });
    await expect.element(author).toBeVisible();
    await author.click();
    expect(window.location.hash).toBe("#agent-ada");
    await expect.element(page.getByText(request.text)).toBeVisible();
  } finally {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search + previousHash,
    );
  }
});

it("shows failed replies as needing attention instead of pretending to keep waiting", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: {
      agents: [],
      peerWaits: [
        {
          agentId: "ada",
          requestId: "failed",
          toAgentId: "joker",
          toName: "Joker",
          batchId: "batch",
          status: "failed",
        },
      ],
    },
    connected: true,
    error: null,
  });
  await using _screen = await render(<WaitingForReplies agentId="ada" />);
  await expect.element(page.getByText("Replies need attention")).toBeVisible();
  await expect
    .element(page.getByText("Waiting for replies"))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("Failed", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Joker" }))
    .toHaveAttribute("href", "#agent-joker");
});
