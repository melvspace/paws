import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import type { ChatMessage } from "@paws/contracts";
import { agentsAtom, peerRetriesAtom } from "@paws/client-runtime";
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
  appAtomRegistry.set(peerRetriesAtom, {});
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

it("renders transferred files inside the expandable exchange using the viewing agent's download route", async () => {
  const id = "a".repeat(64);
  await using _screen = await render(
    <History
      messages={[
        {
          ...reply,
          attachments: [
            {
              id,
              name: "review.pdf",
              mediaType: "application/pdf",
              size: 2048,
            },
          ],
        },
      ]}
    />,
  );
  await page.getByText("Update from", { exact: true }).click();
  const download = page.getByRole("link", { name: "review.pdf 2 KB" });
  await expect.element(download).toBeVisible();
  expect(download.element().getAttribute("href")).toBe(
    `/api/agents/ada/chat/attachments/${id}`,
  );
});

const stoppedRecovery = {
  eventId: "stopped-request",
  kind: "request" as const,
  reason: "Paws restarted before this request finished. No reply was received.",
  canRetry: true,
  retried: false,
};
const stoppedWait = {
  agentId: "ada",
  requestId: "stopped-request",
  toAgentId: "joker",
  toName: "Joker",
  batchId: "batch",
  status: "interrupted" as const,
  recovery: stoppedRecovery,
};

it("explains stopped work and shares pending/retry state across both chat recovery controls", async () => {
  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: { agents: [], peerWaits: [stoppedWait] },
  });
  let finish = (_response: Response) => {};
  const fetchMock = vi.spyOn(window, "fetch").mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );

  try {
    await using _screen = await render(
      <>
        <History
          messages={[
            {
              ...request,
              peer: {
                ...request.peer!,
                eventId: "stopped-request",
                delivery: "interrupted",
                recovery: stoppedRecovery,
              },
            },
          ]}
        />
        <WaitingForReplies agentId="ada" />
      </>,
    );
    await expect
      .element(page.getByText(stoppedRecovery.reason))
      .not.toBeInTheDocument();
    expect(page.getByText("Stopped", { exact: true }).elements()).toHaveLength(
      2,
    );
    await expect
      .element(page.getByText("Interrupted", { exact: true }))
      .not.toBeInTheDocument();
    const buttons = page.getByRole("button", { name: "Retry request" });
    expect(buttons.elements()).toHaveLength(2);
    const row = document
      .querySelector(".peer-reply-row")!
      .getBoundingClientRect();
    const retry = buttons.nth(1).element().getBoundingClientRect();
    expect(row.height).toBeLessThan(40);
    expect(
      Math.abs(row.top + row.height / 2 - retry.top - retry.height / 2),
    ).toBeLessThan(1);
    await page.getByRole("button", { name: "Request details" }).nth(0).hover();
    await expect
      .element(page.getByText(stoppedRecovery.reason, { exact: false }))
      .toHaveTextContent(
        `${stoppedRecovery.reason} Retry sends the original request and files again.`,
      );
    await buttons.nth(0).click();
    expect(
      document.querySelector(".chat-peer-event details")?.hasAttribute("open"),
    ).toBe(false);
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    await expect.element(buttons.nth(0)).toBeDisabled();
    await expect.element(buttons.nth(1)).toBeDisabled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/agents/ada/peer-messages/stopped-request/retry",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    finish(
      new Response(JSON.stringify({ requestId: "retry-request" }), {
        status: 202,
      }),
    );
    await expect
      .element(page.getByText("Retry queued", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Waiting for replies", { exact: true }))
      .toBeVisible();
    await expect.element(buttons).not.toBeInTheDocument();
  } finally {
    finish(
      new Response(JSON.stringify({ requestId: "retry-request" }), {
        status: 202,
      }),
    );
    fetchMock.mockRestore();
  }
});

it("keeps retry failures actionable and disables retries while disconnected", async () => {
  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: { agents: [], peerWaits: [stoppedWait] },
  });
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockResolvedValue(
      new Response(
        JSON.stringify({ error: "This agent’s communication queue is full." }),
        { status: 429 },
      ),
    );

  try {
    await using _screen = await render(<WaitingForReplies agentId="ada" />);
    const retry = page.getByRole("button", { name: "Retry request" });
    await retry.click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This agent’s communication queue is full.");
    await expect.element(retry).toBeEnabled();
    appAtomRegistry.update(agentsAtom, (state) => ({
      ...state,
      connected: false,
    }));
    await expect.element(retry).toBeDisabled();
    await expect
      .element(page.getByText("Disconnected", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Request details" }).hover();
    await expect
      .element(page.getByText(stoppedRecovery.reason, { exact: false }))
      .toHaveTextContent(
        `${stoppedRecovery.reason} Retry sends the original request and files again. Reconnect to retry.`,
      );
  } finally {
    fetchMock.mockRestore();
  }
});

it("makes failures in grouped exchanges visible and explains when a request cannot be retried", async () => {
  await using _screen = await render(
    <History
      messages={[
        request,
        {
          ...reply,
          delivery: undefined,
          peer: {
            ...reply.peer!,
            delivery: "interrupted",
            recovery: {
              ...stoppedRecovery,
              eventId: "reply-event",
              kind: "reply",
              canRetry: false,
              reason: "This request is no longer active.",
            },
          },
        },
      ]}
    />,
  );
  await expect
    .element(page.getByText("This request is no longer active."))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Reply details" }).hover();
  await expect
    .element(page.getByText("This request is no longer active."))
    .toHaveTextContent("This request is no longer active.");
  await expect
    .element(page.getByRole("button", { name: "Retry reply" }))
    .not.toBeInTheDocument();
  expect(document.querySelector(".chat-peer-group")?.hasAttribute("open")).toBe(
    true,
  );
});
